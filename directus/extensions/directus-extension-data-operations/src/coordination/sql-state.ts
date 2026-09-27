import { z } from 'zod';

import {
  calculationDomains,
  coordinationDomains,
  isClaimDomain,
  normaliseDomains,
} from './domains.js';
import { storedOutcomeSchema } from './outcomes.js';
import { type OperationsState } from './state.js';

const isoText = (column: string, alias: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${alias}"`;

// The status columns of the singleton, with timestamps rendered as ISO-8601
// text and the heartbeat age measured by the database clock.
export const columns = [
  '"source_revision"',
  '"history_index_input_revision"',
  '"enrollments_input_revision"',
  '"requested_revision"',
  '"completed_revision"',
  '"dirty_domains"',
  '"claim_token"',
  '"claim_owner"',
  '"claim_domain"',
  '"claim_revision"',
  '"claim_fingerprint"',
  '"claim_pages"',
  '"claim_staged"',
  '"claim_retries"',
  isoText('"claim_started_at"', 'claim_started_iso'),
  isoText('"claim_heartbeat_at"', 'claim_heartbeat_iso'),
  '(EXTRACT(EPOCH FROM (clock_timestamp() - "claim_heartbeat_at")) * 1000)::double precision AS "claim_heartbeat_age_ms"',
  '"last_error_code"',
  '"last_error_message"',
  isoText('"last_error_at"', 'last_error_iso'),
  '"last_failed_revision"',
  '"last_failed_domain"',
  '"last_failed_fingerprint"',
  '"last_error_retries"',
  '"calculation_fingerprint"',
  '"publication_fingerprint"',
  '"import_state"',
  '"publication_state"',
  '"publication_outcomes"',
  isoText('"started_at"', 'started_iso'),
  isoText('"finished_at"', 'finished_iso'),
  '"last_run_retries"',
].join(', ');

// SET fragment that clears every claim column.
export const claimClear = [
  '"claim_token" = NULL',
  '"claim_owner" = NULL',
  '"claim_domain" = NULL',
  '"claim_revision" = NULL',
  '"claim_fingerprint" = NULL',
  '"claim_started_at" = NULL',
  '"claim_heartbeat_at" = NULL',
  '"claim_pages" = NULL',
  '"claim_staged" = NULL',
  '"claim_retries" = 0',
].join(', ');

// The input revision of the claimed domain, as inputRevision computes it:
// a calculation's own column (the source revision while it was never
// written), the source revision for publication and a snapshot claim.
export const claimInputRevision = `CASE "claim_domain" ${calculationDomains
  .map(
    (domain) =>
      `WHEN '${domain}' THEN COALESCE("${domain}_input_revision", "source_revision")`,
  )
  .join(' ')} ELSE "source_revision" END`;

// The union of the current dirty domains with the marked ones, in the
// canonical domain order. The trigger function computes the same thing.
export const dirtyUnion = (marked: string): string =>
  `(SELECT COALESCE(json_agg(known.domain ORDER BY known.ordinal), '[]'::json)
  FROM unnest(ARRAY[${coordinationDomains.map((domain) => `'${domain}'`).join(', ')}]) WITH ORDINALITY AS known(domain, ordinal)
  WHERE known.domain IN (SELECT json_array_elements_text(${marked}))
    OR EXISTS (
      SELECT 1 FROM json_array_elements_text(CASE WHEN json_typeof("dirty_domains") = 'array' THEN "dirty_domains" ELSE '[]'::json END) AS dirty(domain)
      WHERE dirty.domain = known.domain
    ))`;

const optionalString = z.string().nullable();
const optionalNumber = z.number().nullable();
const optionalInt = z.number().int().nullable();
const stringList = z.array(z.string()).nullable();
const retries = z.number().int().nonnegative();

// A planned page as plan_pages stores it; a bare token is a plan stored
// before the ranges were kept, which serves the stage decisions only.
const plannedPage = z.union([
  z.string(),
  z.object({
    from: z.number().int(),
    rows: z.number().int().nonnegative(),
    to: z.number().int(),
    token: z.string(),
  }),
]);

export const stateRow = z.object({
  calculation_fingerprint: optionalString,
  claim_domain: optionalString,
  claim_fingerprint: optionalString,
  claim_heartbeat_age_ms: optionalNumber,
  claim_heartbeat_iso: optionalString,
  claim_owner: optionalString,
  claim_pages: z.array(plannedPage).nullable(),
  claim_retries: retries,
  claim_revision: optionalInt,
  claim_staged: stringList,
  claim_started_iso: optionalString,
  claim_token: optionalString,
  completed_revision: z.number().int(),
  dirty_domains: z.array(z.unknown()).nullable(),
  enrollments_input_revision: optionalInt,
  finished_iso: optionalString,
  history_index_input_revision: optionalInt,
  import_state: z.string(),
  last_error_code: optionalString,
  last_error_iso: optionalString,
  last_error_message: optionalString,
  last_error_retries: retries,
  last_failed_domain: optionalString,
  last_failed_fingerprint: optionalString,
  last_failed_revision: optionalInt,
  last_run_retries: retries,
  publication_fingerprint: optionalString,
  // A value edited out of shape by hand (or an outcome map of an earlier
  // shape) is reported as no outcome.
  publication_outcomes: z
    .record(z.string(), storedOutcomeSchema)
    .nullable()
    .catch(null),
  publication_state: z.string(),
  requested_revision: z.number().int(),
  source_revision: z.number().int(),
  started_iso: optionalString,
});

export type StateRow = z.infer<typeof stateRow>;

// A row whose token is set is a claim even when its other claim columns
// are missing (an out-of-band edit, or a row older than the columns): it is
// reported with an empty owner, no domain and revision -1, so no
// token-bearing action can use it, and it is released as abandoned once
// its heartbeat is stale, or at once when it never had one.
const claimOf = (row: StateRow): OperationsState['claim'] =>
  row.claim_token === null
    ? null
    : {
        domain: isClaimDomain(row.claim_domain) ? row.claim_domain : null,
        fingerprint: row.claim_fingerprint ?? '',
        heartbeatAgeMs: row.claim_heartbeat_age_ms ?? Infinity,
        heartbeatAt: row.claim_heartbeat_iso ?? '',
        owner: row.claim_owner ?? '',
        pages:
          row.claim_pages?.map((page) =>
            typeof page === 'string' ? page : page.token,
          ) ?? null,
        ranges: (row.claim_pages ?? []).filter(
          (page) => typeof page !== 'string',
        ),
        retries: row.claim_retries,
        revision: row.claim_revision ?? -1,
        staged: row.claim_staged ?? [],
        startedAt: row.claim_started_iso ?? '',
        token: row.claim_token,
      };

export const toState = (row: StateRow): OperationsState => ({
  calculationFingerprint: row.calculation_fingerprint,
  claim: claimOf(row),
  completedRevision: row.completed_revision,
  dirtyDomains: normaliseDomains(row.dirty_domains ?? []),
  finishedAt: row.finished_iso,
  importState: row.import_state,
  inputRevisions: {
    enrollments: row.enrollments_input_revision ?? row.source_revision,
    history_index: row.history_index_input_revision ?? row.source_revision,
  },
  lastError:
    row.last_error_code === null
      ? null
      : {
          at: row.last_error_iso,
          code: row.last_error_code,
          domain: isClaimDomain(row.last_failed_domain)
            ? row.last_failed_domain
            : null,
          fingerprint: row.last_failed_fingerprint,
          message: row.last_error_message,
          retries: row.last_error_retries,
          revision: row.last_failed_revision,
        },
  lastRunRetries: row.last_run_retries,
  publicationFingerprint: row.publication_fingerprint,
  publicationOutcomes: row.publication_outcomes,
  publicationState: row.publication_state,
  requestedRevision: row.requested_revision,
  sourceRevision: row.source_revision,
  startedAt: row.started_iso,
});
