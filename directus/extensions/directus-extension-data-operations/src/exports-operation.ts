import { defineOperationApi } from '@directus/extensions-sdk';

import { exportsOperationId, runExportAction } from './exports/actions.js';
import { exportDeps } from './exports/directus.js';

// The export operation: readiness and the preparation of every public
// file declared in exports/index.ts.
export default defineOperationApi({
  handler: (options, context) =>
    runExportAction(options, {
      accountability: context.accountability,
      deps: () => exportDeps(context),
    }),
  id: exportsOperationId,
});
