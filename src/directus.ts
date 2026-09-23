import { z } from 'zod';

import type { DirectusConfig } from './config.js';
import type { FlowTemplate } from './flows/flow-template.js';
import type { CollectionSpec, MigrationData } from './schema.js';

import { applyBranding } from './branding.js';
import { derivedDataFlow, derivedDataFlowId } from './derived-data-flow.js';
import {
  createDirectusRequest,
  type DirectusModeRequest,
  type DirectusRequest,
} from './directus-request.js';
import {
  type FlowInstallSummary,
  installFlowTemplates,
} from './flows/install-flows.js';
import {
  ImportInterruptedError,
  type ImportPhase,
} from './import-interruption.js';
import { countApplicationRecords, ExistingDataError } from './import-state.js';
import { findLegacyFlows, LegacyFlowsError } from './legacy-flows.js';
import { chunk, defaultBatchSize } from './migrations/batches.js';
import {
  convertWorkbook,
  type WorkbookConversion,
} from './migrations/workbook-adapter.js';
import { collectionSpecs } from './model.js';
import { loadPublicAssetsFlow } from './public-assets-flow.js';
import { runSetup } from './setup.js';

type ApiField = {
  readonly field: string;
  readonly meta: {
    readonly interface: string;
    readonly readonly: boolean;
    readonly required: boolean;
    readonly sort: number;
    readonly width: 'full' | 'half';
  };
  readonly schema: { readonly is_nullable: boolean };
  readonly type: string;
};

// The field meta the legacy importer wrote for a checkpoint column, which
// a populated deployment still carries. Exported so the tests can lock it
// to the relational installer's baseline.
export const toApiField = (
  spec: CollectionSpec['fields'][number],
  index: number,
): ApiField => {
  const interfaces: Readonly<
    Record<CollectionSpec['fields'][number]['kind'], string>
  > = {
    boolean: 'boolean',
    integer: 'input',
    string: 'input',
    text: 'input-multiline',
  };

  return {
    field: spec.target,
    meta: {
      interface: interfaces[spec.kind],
      readonly: spec.derived === true,
      required: spec.required === true,
      sort: index + 1,
      width: spec.kind === 'text' ? 'full' : 'half',
    },
    schema: { is_nullable: spec.required !== true },
    type: spec.kind,
  };
};

// The aggregate summary `npm run setup` prints.
export type SetupReport = Readonly<Record<string, unknown>>;

export type ImportIo = {
  // Rows per POST; the importer's bound of 250 unless a test lowers it.
  readonly batchSize?: number;
  readonly now: () => string;
  readonly runToken: () => string;
  // `npm run setup`; tests substitute a stand-in for the schema installer.
  readonly setup?: (request: DirectusRequest) => Promise<SetupReport>;
};

// What the rebuild operation answers when it ran; a Studio-edited Flow may
// answer something else, which is reported as null rather than refused.
const rebuildResult = z.object({
  courses: z.number().int().nonnegative(),
  studentCouncilMembers: z.number().int().nonnegative(),
});

export type ImportSummary = {
  readonly conversion: WorkbookConversion;
  readonly flows: FlowInstallSummary;
  readonly rebuild: null | z.infer<typeof rebuildResult>;
  readonly rows: Readonly<Record<string, number>>;
  readonly setup: SetupReport;
};

const createdIds = z.array(z.object({ id: z.number().int() }));

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  method: 'POST',
});

// Every workbook row into its checkpoint collection, in workbook order and
// bounded batches; Directus must confirm every row of a batch. `confirmed`
// hears each batch's stored rows, so an interruption can tell whether the
// project already holds some.
const writeSourceRows = async (
  request: DirectusRequest,
  {
    batchSize,
    data,
  }: { readonly batchSize: number; readonly data: MigrationData },
  confirmed: (rows: number) => void,
): Promise<Readonly<Record<string, number>>> => {
  const written: Array<[string, number]> = [];
  for (const spec of collectionSpecs) {
    const batches = chunk(data[spec.key], batchSize);
    for (const batch of batches) {
      const created = createdIds.parse(
        await request(`/items/${spec.key}?fields=id`, json(batch)),
      );
      confirmed(created.length);
      if (created.length !== batch.length) {
        throw new Error(
          `Directus confirmed ${String(created.length)} of ${String(batch.length)} ${spec.key} rows in one batch.`,
        );
      }
    }
    written.push([spec.key, data[spec.key].length]);
  }
  return Object.fromEntries(written);
};

// The initial rebuild the checkpoint importer always ran, through the
// manual Flow (which answers the operation result undecoded).
const triggerRebuild = async (
  request: DirectusModeRequest,
): Promise<ImportSummary['rebuild']> => {
  const parsed = rebuildResult.safeParse(
    await request(
      `/flows/trigger/${derivedDataFlowId}`,
      json({ collection: 'courses' }),
      'raw',
    ),
  );
  return parsed.success ? parsed.data : null;
};

// The one-time workbook import. It refuses, before any write, a populated
// project (see countApplicationRecords) and a project that holds checkpoint
// Rebuild or Publish Flows under other ids (see findLegacyFlows); runs setup (so an import into an
// empty project equals setup plus import); installs the checkpoint
// Rebuild and Publish Flows once under stable ids; writes the workbook rows
// into the checkpoint collections; converts them through the migration
// ledger exactly as an upgrade would; and runs the initial derived-data
// rebuild. Every refusal happens before the first row is written; a later
// failure raises ImportInterruptedError, whose message depends on how far
// the import got. Only the lifecycle command (`npm run import`, through
// loadImportConfig) calls it.
export const importWorkbook = async (
  request: DirectusModeRequest,
  data: MigrationData,
  io: ImportIo,
): Promise<ImportSummary> => {
  const templates: readonly FlowTemplate[] = [
    derivedDataFlow,
    await loadPublicAssetsFlow(),
  ];
  const records = await countApplicationRecords(request);
  if (Object.keys(records).length > 0) {
    throw new ExistingDataError(records);
  }
  const legacy = await findLegacyFlows(request);
  if (legacy.length > 0) {
    throw new LegacyFlowsError(legacy);
  }
  const setup = await (io.setup ?? runSetup)(request);
  const flows = await installFlowTemplates(request, templates);
  const batchSize = io.batchSize ?? defaultBatchSize;
  const total = collectionSpecs.reduce(
    (sum, { key }) => sum + data[key].length,
    0,
  );
  let phase: ImportPhase = 'writing';
  let confirmed = 0;
  let conversion: null | WorkbookConversion = null;
  try {
    const rows = await writeSourceRows(
      request,
      { batchSize, data },
      (count) => {
        confirmed += count;
      },
    );
    phase = 'converting';
    conversion = await convertWorkbook(request, data, {
      batchSize,
      now: io.now,
      resume: false,
      runToken: io.runToken(),
    });
    phase = 'rebuilding';
    const rebuild = await triggerRebuild(request);
    return { conversion, flows, rebuild, rows, setup };
  } catch (error) {
    throw new ImportInterruptedError(
      { confirmed, conversion, phase, total },
      { cause: error },
    );
  }
};

// The branding command's client. It has no import method: the workbook
// import runs only through importWorkbook, from `npm run import`.
export class DirectusClient {
  readonly #request: DirectusModeRequest;

  public constructor(config: DirectusConfig) {
    this.#request = createDirectusRequest(config);
  }

  public async applyBranding(): Promise<void> {
    await applyBranding((pathname, init) => this.#request(pathname, init));
  }
}
