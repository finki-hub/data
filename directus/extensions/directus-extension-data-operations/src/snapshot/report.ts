import type { SnapshotState, SnapshotStore, SnapshotSummary } from './port.js';

import { activeTable, stagingTable } from './contract.js';

// Whether the active rows are still exactly the snapshot the last
// completed promotion made active: false once someone changed them outside
// the snapshot workflow (Studio, REST, the native import), null while
// nothing was ever promoted. The promoted identity is kept apart from the
// staging columns, so a later import, whether it succeeds or fails, never
// hides such a change.
const matchesPromotion = (
  state: SnapshotState,
  active: SnapshotSummary,
): boolean | null =>
  state.promoted === null
    ? null
    : active.rows === state.promoted.rows &&
      active.fingerprint === state.promoted.fingerprint;

// The bounded snapshot status for administrators: the import state, the
// staged and the active row counts with their fingerprints, the backup,
// the promoted snapshot and whether the active rows still equal it.
// Counts and hashes only, never a row and never the run token.
export const snapshotReport = (store: SnapshotStore) =>
  store.transaction(async ({ snapshot }) => {
    await snapshot.consistentRead();
    const state = await snapshot.read();
    const staging = await snapshot.summary(stagingTable);
    const active = await snapshot.summary(activeTable);
    return {
      active,
      activeMatchesPromotion: matchesPromotion(state, active),
      backup: {
        file: state.backupFile,
        fingerprint: state.backupFingerprint,
        rows: state.backupRows,
      },
      error: state.error,
      file: state.file,
      fingerprint: state.fingerprint,
      finishedAt: state.finishedAt,
      promoted: state.promoted,
      rows: state.rows,
      staging,
      startedAt: state.startedAt,
      state: state.state,
      warnings: state.warnings,
    };
  });

export type SnapshotReport = Awaited<ReturnType<typeof snapshotReport>>;
