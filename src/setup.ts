import type { DirectusRequest } from './directus-request.js';

import { installCheckpointPresets } from './checkpoint-presets.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from './data-model/constraints.js';
import { installDataModel } from './data-model/install.js';
import { installPresentation } from './data-model/presentation.js';
import { installMappedEnrollmentFlows } from './flows/count-mapped-enrollments.js';
import { installHistoryIndexFlows } from './flows/index-histories.js';
import { installSnapshotFolder } from './flows/snapshot-folder.js';
import { installSnapshotImportFlows } from './flows/snapshot-import.js';

// What `npm run setup` installs, in order: the schema, the database
// constraints and source-invalidation triggers, the Studio presentation,
// the checkpoint table views with the Search bookmark, the private folder
// of the Moodle snapshot files and the Flow templates (history index,
// snapshot import, mapped enrollment counts). Every step is
// idempotent and install-once (a rerun preserves Studio edits to presets,
// the folder and Flows) and none writes a data record.
// The workbook import runs exactly this before it writes any row, so an
// import into an empty project equals setup followed by the import.
export const runSetup = async (request: DirectusRequest) => {
  const summary = await installDataModel(request);
  const constraints = await applySchemaConstraints(request);
  const invalidation = await applySourceInvalidation(request);
  const presentation = await installPresentation(request);
  const presets = await installCheckpointPresets(request);
  const folders = await installSnapshotFolder(request);
  const history = await installHistoryIndexFlows(request);
  const snapshot = await installSnapshotImportFlows(request);
  const enrollments = await installMappedEnrollmentFlows(request);
  const flows = {
    created: [...history.created, ...snapshot.created, ...enrollments.created],
    skipped: [...history.skipped, ...snapshot.skipped, ...enrollments.skipped],
  };
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
