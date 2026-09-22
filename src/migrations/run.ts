import path from 'node:path';

import type { DirectusConfig } from '../config.js';
import type { DirectusRequest } from '../directus-request.js';
import type { ConverterSink } from './converter-types.js';

import { BackupReceiptError, validateBackupReceipt } from './backup-receipt.js';
import { defaultBatchSize } from './batches.js';
import {
  loadMigrationConfig,
  type MigrationConfig,
  MigrationConfigError,
} from './config.js';
import { converterSteps } from './converters.js';
import { fingerprintInventory } from './fingerprint.js';
import { readInventory } from './inventory.js';
import { ledgerCollection } from './ledger-claim.js';
import { LedgerRefusalError } from './ledger-types.js';
import { readLedgerOrNull, runLedger, summarizeLedger } from './ledger.js';
import { preflight } from './preflight.js';
import {
  PrivateFileError,
  readPrivateJson,
  writePrivateJson,
} from './private-files.js';
import {
  type Finding,
  type MigrationReport,
  migrationReportSchema,
  migrationVersion,
} from './report.js';

export type CliIo = {
  // Rows per write batch; the CLI uses the default and tests lower it to
  // exercise an interruption between batches.
  readonly batchSize?: number;
  readonly createRequest: (config: DirectusConfig) => DirectusRequest;
  readonly now: () => string;
  readonly runToken: () => string;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

export class MigrationRefusalError extends Error {
  public override readonly name = 'MigrationRefusalError';
}

const collator = new Intl.Collator('en');

const countByCode = (
  findings: readonly Finding[],
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const { code } of findings) {
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries(
    counts
      .entries()
      .toArray()
      .toSorted(([left], [right]) => collator.compare(left, right)),
  );
};

const dryRun = async (
  config: MigrationConfig,
  request: DirectusRequest,
  io: CliIo,
): Promise<void> => {
  const inventory = await readInventory(request, {});
  const ledger = await readLedgerOrNull(request, migrationVersion);
  const report = preflight(
    inventory,
    ledger === null ? null : summarizeLedger(ledger),
  );
  await writePrivateJson(config.report, report);
  io.stdout(
    JSON.stringify({
      blockers: report.blockers.length,
      counts: report.counts,
      findings: countByCode([...report.blockers, ...report.warnings]),
      ledger: report.ledger,
      migratable: report.migratable,
      mode: 'dry-run',
      reportWritten: true,
      sourceFingerprint: report.sourceFingerprint,
      targets: report.targets,
      version: report.version,
      warnings: report.warnings.length,
    }),
  );
};

const readReport = async (
  config: MigrationConfig,
): Promise<MigrationReport> => {
  const parsed = migrationReportSchema.safeParse(
    await readPrivateJson(config.report, 'dry-run report'),
  );
  if (!parsed.success) {
    throw new MigrationRefusalError(
      `The report at ${config.report} is not a ${migrationVersion} dry-run report: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
    );
  }
  if (!parsed.data.migratable || parsed.data.blockers.length > 0) {
    throw new MigrationRefusalError(
      `The report records ${String(parsed.data.blockers.length)} blocker(s); resolve them and run a new dry-run before applying.`,
    );
  }
  return parsed.data;
};

// The apply gates in order: a blocker-free report, a backup receipt taken
// against the report's fingerprint whose artifacts exist, an unchanged live
// source, readable target collections (their provenance is what stops a
// re-run from writing rows twice, so an unreadable model never passes as
// "nothing written yet"), a blocker-free live preflight, then the ledger.
const apply = async (
  config: MigrationConfig,
  request: DirectusRequest,
  io: CliIo,
): Promise<void> => {
  const report = await readReport(config);
  if (config.backupReceipt === null) {
    throw new MigrationRefusalError('--apply requires a backup receipt.');
  }
  const receipt = await validateBackupReceipt(
    await readPrivateJson(config.backupReceipt, 'backup receipt'),
    report.sourceFingerprint,
    path.dirname(config.backupReceipt),
  );
  const inventory = await readInventory(request, {});
  const sourceFingerprint = fingerprintInventory(inventory);
  if (sourceFingerprint !== report.sourceFingerprint) {
    throw new MigrationRefusalError(
      `Source drift: the report was taken against fingerprint ${report.sourceFingerprint} but the project now fingerprints ${sourceFingerprint}. Run a new dry-run and a new backup before applying.`,
    );
  }
  if (inventory.targets === null) {
    throw new MigrationRefusalError(
      'The relational target collections are not readable; run npm run setup (or grant the token read access to them) and take a fresh dry-run before applying.',
    );
  }
  const live = preflight(inventory, null);
  if (live.blockers.length > 0) {
    throw new MigrationRefusalError(
      `The live preflight found ${String(live.blockers.length)} blocker(s); nothing was applied.`,
    );
  }
  const existing = live.mappings.filter(({ targetId }) => targetId !== null);
  const sink: ConverterSink = { findings: [], written: {} };
  const converters = converterSteps(inventory, live, {
    batchSize: io.batchSize ?? defaultBatchSize,
    sink,
  });
  const outcome = await runLedger(request, {
    now: io.now,
    resume: config.resume,
    runToken: io.runToken(),
    sourceFingerprint,
    steps: [
      { run: () => Promise.resolve(existing), step: 'preflight' },
      ...converters,
    ],
    version: migrationVersion,
  });
  io.stdout(
    JSON.stringify({
      backup: receipt,
      converters: converters.length,
      ledger: ledgerCollection,
      message: `${String(converters.length)} converter step(s) ran under the ledger; no checkpoint scalar column was modified or deleted: target rows were appended, only empty link columns of council and equivalency rows were set, and unresolved relations are retained for review`,
      mode: 'apply',
      sourceFingerprint,
      steps: outcome,
      unresolved: countByCode(sink.findings),
      version: migrationVersion,
      written: sink.written,
    }),
  );
};

const isRefusal = (error: unknown): boolean =>
  error instanceof MigrationRefusalError ||
  error instanceof MigrationConfigError ||
  error instanceof BackupReceiptError ||
  error instanceof LedgerRefusalError ||
  error instanceof PrivateFileError;

// The CLI body: returns the process exit code and prints aggregate JSON only.
export const runMigrationCli = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> => {
  try {
    const config = loadMigrationConfig(arguments_, environment);
    const request = io.createRequest(config.directus);
    await (config.mode === 'dry-run'
      ? dryRun(config, request, io)
      : apply(config, request, io));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(
      `Migration ${isRefusal(error) ? 'refused' : 'failed'}: ${message}`,
    );
    return 1;
  }
};
