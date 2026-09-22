import type { DirectusRequest } from '../directus-request.js';
import type { ConverterSink } from './converter-types.js';
import type { Inventory } from './inventory.js';
import type { LedgerOutcome } from './ledger-types.js';

import { converterSteps } from './converters.js';
import { runLedger } from './ledger.js';
import {
  type Finding,
  type MigrationReport,
  migrationVersion,
} from './report.js';

export type ConversionPlan = {
  readonly batchSize: number;
  readonly now: () => string;
  readonly resume: boolean;
  readonly runToken: string;
};

export type ConversionResult = {
  readonly converters: number;
  readonly outcome: LedgerOutcome;
  readonly sink: ConverterSink;
};

const collator = new Intl.Collator('en');

// Finding counts per code, sorted by code: the only view of findings a
// command prints on stdout.
export const countByCode = (
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

// The relational conversion both lifecycle paths run, the populated
// upgrade (`npm run migrate -- --apply`) and the one-time workbook import:
// under the versioned ledger, the preflight step records the target rows
// that already exist, then the converter steps write what is missing in
// bounded batches. `live` is the preflight of `inventory` taken now; its
// source fingerprint is the one every ledger step records.
export const runConversion = async (
  request: DirectusRequest,
  {
    inventory,
    live,
  }: { readonly inventory: Inventory; readonly live: MigrationReport },
  plan: ConversionPlan,
): Promise<ConversionResult> => {
  const existing = live.mappings.filter(({ targetId }) => targetId !== null);
  const sink: ConverterSink = { findings: [], written: {} };
  const converters = converterSteps(inventory, live, {
    batchSize: plan.batchSize,
    sink,
  });
  const outcome = await runLedger(request, {
    now: plan.now,
    resume: plan.resume,
    runToken: plan.runToken,
    sourceFingerprint: live.sourceFingerprint,
    steps: [
      { run: () => Promise.resolve(existing), step: 'preflight' },
      ...converters,
    ],
    version: migrationVersion,
  });
  return { converters: converters.length, outcome, sink };
};
