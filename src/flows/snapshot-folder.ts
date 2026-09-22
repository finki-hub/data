import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { FlowInstallSummary } from './install-flows.js';

import { snapshotId } from './flow-template.js';

// The private File Library folder of the Moodle snapshot workflow. The
// import operation accepts a CSV only from this folder and writes every
// pre-replacement backup into it, so a role that may read files can be kept
// away from all snapshot files with one permission filter on the folder
// (the editing roles of Tasks 14/15 must carry it). Its id is
// deterministic; the data-operations bundle names the same id
// (snapshot/contract.ts, kept equal by test/snapshot-flow.test.ts).
export const snapshotFolder = {
  id: snapshotId('f0'),
  name: 'Moodle snapshots (private)',
} as const;

const folderListing = z.array(z.object({ id: z.string() }));

// Creates the folder once; an existing folder keeps every Studio edit
// (name, parent), like an installed Flow template.
export const installSnapshotFolder = async (
  request: DirectusRequest,
): Promise<FlowInstallSummary> => {
  const [existing] = folderListing.parse(
    await request(
      `/folders?fields=id&limit=1&filter[id][_eq]=${snapshotFolder.id}`,
    ),
  );
  if (existing !== undefined) {
    return { created: [], skipped: [snapshotFolder.name] };
  }
  await request('/folders', {
    body: JSON.stringify({ ...snapshotFolder, parent: null }),
    method: 'POST',
  });
  return { created: [snapshotFolder.name], skipped: [] };
};
