import type { PageRange } from '../page-state.js';
import type { CalculationDomain, ClaimDomain, Domain } from './domains.js';
import type { StoredOutcomes } from './outcomes.js';

// A failure message kept in the status is cut to this many characters, so
// a caller can pass a whole failure record without a size check of its own.
export const errorMessageLength = 600;

// What plan_pages may plan: one source table, paged by id under its own
// claim domain (pageSourceDomains).
export const planSources = ['history', 'entries'] as const;

export type PageSource = (typeof planSources)[number];

// The only tables the page planner ever reads, keyed by the enumerated
// source names an operation may name: the Moodle users a history index
// claim indexes, and the history lines an enrollments claim matches.
export const pageSourceTables: Readonly<Record<PageSource, string>> = {
  entries: 'moodle_course_entries',
  history: 'moodle_users',
};

// A publication records at most this many per-file outcomes, keyed by
// the published filename (courses.json, ...).
export const maxPublishedFiles = 64;

export const operationId = 'finki-hub-data-coordinate';

// A claim whose heartbeat is older than this is abandoned: its process died
// or its Flow stopped without calling fail. A running job refreshes the
// heartbeat with every plan_pages, stage_page, heartbeat or record call, so
// a live claim is never taken away by time alone.
export const claimStaleAfterMs = 60_000;

// A heartbeat of a publication claim leases it for the upload that follows
// (the claim counts as alive until the lease ends), so recovery never
// releases a claim whose upload may still write its object: a later
// publication would otherwise be overwritten by the older body without a
// trace. Directus replaces a file through three S3 calls before the object
// itself is written (PutObject of a temp object, ListObjectsV2 of the id
// prefix, CopyObject), each tried three times by the SDK with the S3
// driver's 5 s connection and 120 s socket timeouts: about 19 minutes at
// worst. The `record` of the file's outcome ends the lease. A Directus that
// dies in the middle of an upload therefore holds every claim until the
// lease and the stale window have passed.
export const publicationUploadLeaseMs = 20 * 60_000;

// How long a claim waits for the singleton row lock. A source transaction
// holds that lock from its first statement to its commit (a long import
// batch, a snapshot promotion); a scheduled tick behind it answers busy
// instead of holding a pooled connection until the commit.
export const claimLockWaitMs = 2_000;

// Every planned page covers at most this many source rows: Moodle users
// of a history index page, history lines of an enrollments page.
export const pageSize = 250;

// The only claim domain each table source may be planned under.
export const pageSourceDomains: Readonly<Record<PageSource, Domain>> = {
  entries: 'enrollments',
  history: 'history_index',
};

export const maxRowsPerPage = 10_000;

export const textCollator = new Intl.Collator('en');

// Timestamps are ISO-8601 strings rendered by the database; the heartbeat
// age is measured by the database clock so every process judges staleness
// the same way.
export type Claim = {
  // Null only for a status row whose token survived while its other claim
  // columns did not; such a claim serves no action and is released as
  // abandoned.
  readonly domain: ClaimDomain | null;
  readonly fingerprint: string;
  // Negative while a publication's upload lease runs: the heartbeat is
  // dated to the end of the lease.
  readonly heartbeatAgeMs: number;
  readonly heartbeatAt: string;
  readonly owner: string;
  readonly pages: null | readonly string[];
  // The id range and row count of every planned page, as the plan read
  // them at the claimed revision; empty for a plan stored without them.
  readonly ranges: readonly PageRange[];
  // How often the transactions of the run so far ran again after a
  // deadlock or serialization failure (conflict-retry.ts).
  readonly retries: number;
  readonly revision: number;
  readonly staged: readonly string[];
  readonly startedAt: string;
  readonly token: string;
};

export type LastError = {
  readonly at: null | string;
  readonly code: string;
  readonly domain: ClaimDomain | null;
  readonly fingerprint: null | string;
  // What the failing step said (ids and counts only), cut to
  // errorMessageLength; null when the release named no cause.
  readonly message: null | string;
  // The released claim's retries after a database conflict.
  readonly retries: number;
  readonly revision: null | number;
};

// The coordination singleton as the decisions see it.
export type OperationsState = {
  readonly calculationFingerprint: null | string;
  readonly claim: Claim | null;
  readonly completedRevision: number;
  readonly dirtyDomains: readonly Domain[];
  readonly finishedAt: null | string;
  readonly importState: string;
  // Per calculation domain, the source revision of the last statement or
  // mark that touched its inputs (its own domain or an upstream one), so a
  // publication-only edit never overtakes or retries a calculation. The
  // source revision itself stands in while a column was never written.
  readonly inputRevisions: Readonly<Record<CalculationDomain, number>>;
  readonly lastError: LastError | null;
  // The last completed claim's retries after a database conflict.
  readonly lastRunRetries: number;
  readonly publicationFingerprint: null | string;
  // The outcome of each declared file of the last publication that
  // recorded one (a completion, a failed run that attempted its files, or
  // an overtaken one), keyed by filename; null when none was recorded.
  readonly publicationOutcomes: null | StoredOutcomes;
  readonly publicationState: string;
  readonly requestedRevision: number;
  readonly sourceRevision: number;
  readonly startedAt: null | string;
};
