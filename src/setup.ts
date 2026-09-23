import type { DirectusRequest } from './directus-request.js';

import { installCheckpointPresets } from './checkpoint-presets.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from './data-model/constraints.js';
import { installDataModel } from './data-model/install.js';
import { installPresentation } from './data-model/presentation.js';
import { installFlowFamilies } from './flows/registry.js';
import { installSnapshotFolder } from './flows/snapshot-folder.js';

// What `npm run setup` installs, in order: the schema (realigning the
// choices and validation of every declared enum), the database constraints
// and source-invalidation triggers, the Studio presentation, the checkpoint
// table views with the Search bookmark, the private folder of the Moodle
// snapshot files and every registered Flow family through one loop
// (registry.ts: automatic processing last, so the first tick of its
// schedule finds every child). Every step is idempotent and install-once (a
// rerun preserves Studio edits to presets, the folder and Flows) and none
// writes a data record; from then on the schedule computes the derived
// rows by itself. The workbook import runs exactly this before it writes
// any row, so an import into an empty project equals setup followed by the
// import.
export const runSetup = async (request: DirectusRequest) => {
  const summary = await installDataModel(request);
  const constraints = await applySchemaConstraints(request);
  const invalidation = await applySourceInvalidation(request);
  const presentation = await installPresentation(request);
  const presets = await installCheckpointPresets(request);
  const folders = await installSnapshotFolder(request);
  const flows = await installFlowFamilies(request);
  return {
    ...summary,
    constraints,
    flows,
    folders,
    invalidation,
    presentation,
    presets,
  };
};

export type SetupSummary = Awaited<ReturnType<typeof runSetup>>;
