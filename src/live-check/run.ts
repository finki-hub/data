import type { ModelCollectionKey } from '../schema.js';

import {
  readFileSources,
  serializeFile,
  type SourceReader,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import {
  fileShape,
  validateFile,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';
import { exportDefinitions } from '../../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { loadLiveCheckConfig } from '../config.js';
import { refusalCount, rowPlaceOf } from '../import-report.js';
import { reportBlocked } from '../import-run.js';
import { type ImportPlan, planImport } from '../import/plan.js';
import { exitCodes, reportFailure } from '../lifecycle.js';
import { projectedCounts } from '../projection/counts.js';
import { storeReader } from '../projection/memory-reader.js';
import { memoryStore, withRows } from '../projection/memory-store.js';
import { printSummary } from '../text.js';
import { loadWorkbook, type WorkbookContent } from '../workbook.js';
import { compareLive } from './compare.js';
import {
  type Fetch,
  fetchLiveFiles,
  type LiveData,
  type LiveFile,
  publicRows,
} from './fetch.js';

export type LiveCheckIo = {
  readonly fetch: Fetch;
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
};

// One file as the export engine publishes it over the reader, validated
// and parsed back from its body.
const projectedFile = async (file: LiveFile, reader: SourceReader) => {
  const definition = exportDefinitions.find(
    ({ filename }) => filename === file,
  );
  if (definition === undefined) {
    throw new TypeError(`${file}: no export definition`);
  }
  const sources = await readFileSources(definition, reader);
  const { body } = validateFile(
    definition,
    serializeFile(definition, sources),
    fileShape(definition, sources),
  );
  return publicRows.parse(JSON.parse(body));
};

const projectedFiles = async (reader: SourceReader): Promise<LiveData> => {
  const courses = await projectedFile('courses.json', reader);
  const staff = await projectedFile('staff.json', reader);
  const rooms = await projectedFile('rooms.json', reader);
  return { 'courses.json': courses, 'rooms.json': rooms, 'staff.json': staff };
};

// The workbook place of each planned row of a collection, in plan order:
// the order of its rows in the store and in the projected file.
const placesOf = (
  plan: ImportPlan,
  { places }: Pick<WorkbookContent, 'places'>,
  collection: ModelCollectionKey,
): readonly string[] =>
  (
    plan.collections.find((entry) => entry.collection === collection)?.rows ??
    []
  ).map((row) => rowPlaceOf({ collection, ...row }, places));

// `npm run compare:live`: projects courses.json, staff.json and rooms.json
// from the workbook named by WORKBOOK_PATH as a fresh import of it would
// publish them, fetches the live files and prints their comparison as one
// JSON document (src/live-check/compare.ts), without a value of a person
// or a room. It writes nothing. Exit codes: 0 compared (differences are
// reported, never a failure); 1 failed (the workbook, the projection or a
// live file); 2 refused (no WORKBOOK_PATH, an argument); 3 blocked (the
// cases the dry run reports, on stderr as it reports them).
export const runLiveCheck = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: LiveCheckIo,
): Promise<number> => {
  try {
    const { workbookPath } = loadLiveCheckConfig(arguments_, environment);
    const workbook = await loadWorkbook(workbookPath);
    const plan = planImport(workbook);
    if (refusalCount(plan) > 0) {
      reportBlocked('Live check', { plan, workbook }, io.stderr);
      return exitCodes.blocked;
    }
    const store = memoryStore(plan.collections);
    const counts = projectedCounts(store);
    const projected = await projectedFiles(
      storeReader(withRows(store, 'course_enrollments', counts.rows)),
    );
    const live = await fetchLiveFiles(io.fetch);
    const comparison = compareLive({
      live,
      places: {
        'rooms.json': placesOf(plan, workbook, 'rooms'),
        'staff.json': placesOf(plan, workbook, 'staff'),
      },
      projected,
      yearsCompared: counts.derived,
    });
    printSummary(io, { workbook: workbookPath, ...comparison });
    return exitCodes.ok;
  } catch (error) {
    return reportFailure('Live check', error, io);
  }
};
