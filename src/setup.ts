import type { DirectusRequest } from './directus-request.js';

import {
  applySchemaConstraints,
  applySourceInvalidation,
} from './data-model/constraints.js';
import { installDataModel } from './data-model/install.js';
import { installOperationsDashboard } from './data-model/operations-dashboard.js';
import { installPresentation } from './data-model/presentation.js';
import { installEditorPolicy } from './editor-policy-install.js';
import { installFlowFamilies } from './flows/registry.js';
import { installSnapshotFolder } from './flows/snapshot-folder.js';

// What `npm run setup` installs, in order: the schema (realigning the
// choices and validation of every declared enum), the database constraints
// and source-invalidation triggers, the Studio presentation (its default
// table views and bookmarks, the Search bookmark among them), the private
// folder of the Moodle snapshot files, every registered Flow family through one loop
// (registry.ts: automatic processing last, so the first tick of its
// schedule finds every child), the Data operations dashboard whose panels
// name those Flows, and the editor policy. Every step is idempotent;
// everything but the code-owned editor policy (kept equal to its
// derivation from the collection roles) installs once, so a rerun
// preserves Studio edits to presets, the folder, Flows and the dashboard.
// None writes a data record; from then on the schedule computes the derived
// rows by itself. The workbook import runs exactly this before it writes
// any row, so an import into an empty project equals setup followed by the
// import.
export const runSetup = async (request: DirectusRequest) => {
  const summary = await installDataModel(request);
  const constraints = await applySchemaConstraints(request);
  const invalidation = await applySourceInvalidation(request);
  const presentation = await installPresentation(request);
  const folders = await installSnapshotFolder(request);
  const flows = await installFlowFamilies(request);
  const dashboard = await installOperationsDashboard(request);
  const editorPolicy = await installEditorPolicy(request);
  return {
    ...summary,
    constraints,
    dashboard,
    editorPolicy,
    flows,
    folders,
    invalidation,
    presentation,
  };
};

export type SetupSummary = Awaited<ReturnType<typeof runSetup>>;
