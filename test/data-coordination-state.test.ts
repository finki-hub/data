import { describe, expect, test } from 'vitest';

import {
  abandonedClaim,
  decideClaim,
  verifyClaim,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/decisions.js';
import {
  type StateRow,
  stateRow,
  toState,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-state.js';
import {
  claimStaleAfterMs,
  type OperationsState,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';

const uuid = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const history = 'history_index';
const publication = 'publication';
const graphA = 'graph-a';
const processA = 'process-a';

// A data_operations row as the SQL port reads it, idle unless overridden.
const statusRow = (overrides: Partial<StateRow> = {}): StateRow => ({
  calculation_fingerprint: graphA,
  claim_domain: null,
  claim_fingerprint: null,
  claim_heartbeat_age_ms: null,
  claim_heartbeat_iso: null,
  claim_owner: null,
  claim_pages: null,
  claim_revision: null,
  claim_staged: null,
  claim_started_iso: null,
  claim_token: null,
  completed_revision: 3,
  dirty_domains: [publication],
  finished_iso: null,
  import_state: 'idle',
  last_error_code: null,
  last_error_iso: null,
  last_failed_domain: null,
  last_failed_fingerprint: null,
  last_failed_revision: null,
  publication_fingerprint: graphA,
  publication_state: 'idle',
  publish_courses_outcome: null,
  publish_rooms_outcome: null,
  publish_staff_outcome: null,
  publish_students_outcome: null,
  requested_revision: 3,
  source_revision: 3,
  started_iso: null,
  ...overrides,
});

describe('status row mapping', () => {
  test('maps an idle row to a state without a claim', () => {
    const state: OperationsState = toState(stateRow.parse(statusRow()));

    expect(state.claim).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.dirtyDomains).toEqual([publication]);
    expect(state.sourceRevision).toBe(3);
  });

  test('sees a row whose token survived its other claim columns as an abandoned claim', () => {
    const malformed = toState(stateRow.parse(statusRow({ claim_token: uuid })));
    const request = {
      currentFingerprint: graphA,
      domain: publication,
      retry: false,
    } as const;

    expect(malformed.claim).toEqual({
      domain: null,
      fingerprint: '',
      heartbeatAgeMs: Infinity,
      heartbeatAt: '',
      owner: '',
      pages: null,
      revision: -1,
      staged: [],
      startedAt: '',
      token: uuid,
    });
    expect(decideClaim(malformed, request)).toMatchObject({ kind: 'busy' });
    expect(abandonedClaim(malformed, claimStaleAfterMs)?.token).toBe(uuid);
    expect(verifyClaim(malformed, { owner: processA, token: uuid })).toBe(
      'owner_mismatch',
    );
    expect(toState(stateRow.parse(statusRow())).claim).toBeNull();

    const live = toState(
      stateRow.parse(
        statusRow({
          claim_domain: history,
          claim_fingerprint: graphA,
          claim_heartbeat_age_ms: 5,
          claim_owner: processA,
          claim_revision: 3,
          claim_token: uuid,
        }),
      ),
    );

    expect(live.claim).toMatchObject({
      domain: history,
      heartbeatAgeMs: 5,
      owner: processA,
      revision: 3,
    });
    expect(abandonedClaim(live, claimStaleAfterMs)).toBeNull();
    expect(decideClaim(live, request)).toEqual({
      claim: live.claim,
      kind: 'busy',
    });
  });
});
