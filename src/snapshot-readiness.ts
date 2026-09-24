import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

import { readinessEntry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';

// The snapshot findings an operator can read on demand (Task 13; moved out
// of the editor policy by Task 16): active Moodle users changed outside
// the snapshot workflow and a failed import, under the codes readiness
// counts them with.

// The part of GET /finki-hub-data-operations/snapshot the readiness check
// reads (Task 10): counts, fingerprints and states, never a row.
const snapshotReport = z.object({
  active: z.object({ fingerprint: z.string(), rows: z.number().int() }),
  activeMatchesPromotion: z.boolean().nullable(),
  promoted: z
    .object({ fingerprint: z.string(), rows: z.number().int() })
    .nullable(),
  state: z.string(),
});

export type SnapshotReadinessFinding = {
  readonly code: string;
  readonly message: string;
};

// A code of the readiness-check registry that readiness counts from the
// snapshot status too: the policy reports the same issue under the same
// code, and a code the registry drops fails here at load.
const snapshotCode = (code: string): string => {
  if (readinessEntry(code)?.source.kind !== 'snapshot') {
    throw new Error(`The readiness registry declares no snapshot code ${code}`);
  }
  return code;
};

export const activeSnapshotEdited = snapshotCode('active_snapshot_edited');
export const snapshotImportFailed = snapshotCode('snapshot_import_failed');

// Flags the unsupported writes the snapshot workflow can see: active Moodle
// users that no longer equal the snapshot the last promotion made active
// (an edit in Studio, over REST or through the native CSV import by an
// administrator, whom no policy restricts), and a failed import whose
// staging must not be promoted. Nothing is flagged before the first
// promotion.
export const snapshotReadiness = (
  report: unknown,
): readonly SnapshotReadinessFinding[] => {
  const parsed = snapshotReport.parse(report);
  const findings: SnapshotReadinessFinding[] = [];
  if (parsed.activeMatchesPromotion === false) {
    findings.push({
      code: activeSnapshotEdited,
      message: `The active Moodle users (${String(parsed.active.rows)} rows) no longer equal the snapshot the last promotion made active (${String(parsed.promoted?.rows ?? 0)} rows): they were changed outside Data / Import Moodle snapshot. The next promotion replaces those changes.`,
    });
  }
  if (parsed.state === 'failed') {
    findings.push({
      code: snapshotImportFailed,
      message:
        'The last snapshot import or promotion failed; the active Moodle users are unchanged by it and its staging is not promoted.',
    });
  }
  return findings;
};

// Reads the snapshot status (administrators only) and returns its
// findings. The status fingerprints every active Moodle user, so this is
// an on-demand check, never part of a scheduled path.
export const readSnapshotReadiness = async (
  request: DirectusRequest,
): Promise<readonly SnapshotReadinessFinding[]> =>
  snapshotReadiness(await request('/finki-hub-data-operations/snapshot'));
