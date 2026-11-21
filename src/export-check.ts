import type { SourceReader } from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import type { PreparedFile } from '../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';
import type { DirectusRequest } from './directus-request.js';

import { readQuery } from '../directus/extensions/directus-extension-data-operations/src/exports/directus.js';
import { catalogFiles } from '../directus/extensions/directus-extension-data-operations/src/catalog-endpoint.js';

// The export check: builds every /catalog file with this checkout's export
// code from a running Directus's data, read through its REST API, so a
// change can be tried on the live data before it is deployed. It only
// reads. Each file is compared with the one the project serves now.

type CheckedFile = {
  readonly build: (reader: SourceReader) => Promise<PreparedFile>;
  readonly filename: string;
};

export type ExportCheckIo = {
  // The body the project serves now for a /catalog file, or null without one.
  readonly liveFile: (filename: string) => Promise<null | string>;
  readonly request: DirectusRequest;
  readonly stdout: (line: string) => void;
};

// A query parameter as the REST API reads it: a list joined by commas, an
// object as JSON.
const parameter = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : String(value);
};

// The reads of the export engine, sent as the same native query the
// extension runs (readQuery), through REST.
export const restReader =
  (request: DirectusRequest): SourceReader =>
  async (read) => {
    const query = Object.entries(readQuery(read))
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(parameter(value))}`,
      )
      .join('&');
    const items = await request(
      `/items/${encodeURIComponent(read.collection)}?${query}`,
    );
    if (!Array.isArray(items)) {
      throw new TypeError(`${read.collection}: the read is not a list`);
    }
    return items as readonly unknown[];
  };

// The rows of a file as texts: the items of a list, the entries of a map,
// else the whole body.
const rowTexts = (body: string): string[] => {
  const parsed: unknown = JSON.parse(body);
  if (Array.isArray(parsed)) {
    return parsed.map((row) => JSON.stringify(row));
  }
  return typeof parsed === 'object' && parsed !== null
    ? Object.entries(parsed).map((entry) => JSON.stringify(entry))
    : [body];
};

// How many rows of `from` are missing in `to`, each row counted as often
// as it occurs.
const missingIn = (from: readonly string[], to: readonly string[]): number => {
  const left = new Map<string, number>();
  for (const row of to) {
    left.set(row, (left.get(row) ?? 0) + 1);
  }
  let missing = 0;
  for (const row of from) {
    const count = left.get(row) ?? 0;
    if (count === 0) {
      missing += 1;
    } else {
      left.set(row, count - 1);
    }
  }
  return missing;
};

// `<rows> rows; live <rows>[, identical | : <n> new, <n> gone]`; a changed
// row counts as one new and one gone.
const comparison = (built: PreparedFile, live: null | string): string => {
  if (live === null) {
    return `${String(built.rows)} rows; not served now`;
  }
  const builtRows = rowTexts(built.body);
  const liveRows = rowTexts(live);
  const added = missingIn(builtRows, liveRows);
  const gone = missingIn(liveRows, builtRows);
  const difference =
    added === 0 && gone === 0
      ? 'identical'
      : `${String(added)} new, ${String(gone)} gone`;
  return `${String(built.rows)} rows; live ${String(liveRows.length)}, ${difference}`;
};

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : JSON.stringify(error);

// One line per file, `<file>: builds, <comparison>` or
// `<file>: refused: <reason>`; true when every file builds.
export const runExportCheck = async (
  io: ExportCheckIo,
  files: readonly CheckedFile[] = catalogFiles,
): Promise<boolean> => {
  const reader = restReader(io.request);
  let builds = true;
  for (const file of files) {
    try {
      const built = await file.build(reader);
      const live = await io.liveFile(file.filename);
      io.stdout(`${file.filename}: builds, ${comparison(built, live)}`);
    } catch (error) {
      builds = false;
      io.stdout(`${file.filename}: refused: ${reasonOf(error)}`);
    }
  }
  return builds;
};
