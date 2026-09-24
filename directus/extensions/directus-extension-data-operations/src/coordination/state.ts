import type { PageRange } from '../page-state.js';
import type { CalculationDomain, ClaimDomain, Domain } from './domains.js';
import type { StoredOutcomes } from './outcomes.js';

// A failure message kept in the status is cut to this many characters, so
// a caller can pass a whole failure record without a size check of its own.
export const errorMessageLength = 600;

export const pageSources = ['history', 'rules'] as const;

export type PageSource = (typeof pageSources)[number];

// What plan_pages may plan: one source table, or `enrollments`, the one
// plan of an enrollments claim that covers every declared rule mode as one
// family of pages (rule-modes.ts), so its completion never drops a
// family's rows.
export const planSources = [...pageSources, 'enrollments'] as const;

export type PlanSource = (typeof planSources)[number];

// The only tables the page planner ever reads, keyed by the enumerated
// source names an operation may name.
export const pageSourceTables: Readonly<Record<PageSource, string>> = {
  history: 'moodle_users',
  rules: 'course_enrollment_rules',
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

// Every planned page covers at most this many source rows.
export const pageSize = 250;

// A legacy rule page holds at most this many legacy_regex rules; its
// Run Script compiles each of them once.
export const legacyRulePageSize = 500;

// The UTF-8 bytes of `Courses` one legacy history page may hold. Run
// Script copies the whole data chain into an isolate of 32 MB and stops it
// after 10 s (the defaults, never raised). Memory: V8 keeps a string with
// any non-Latin-1 character at two bytes per UTF-16 unit and disposes the
// isolate at about 16 MB of string storage, so a page costs at most twice
// its bytes. Time grows with rules times bytes: on the largest page (500
// rules, 800,000 two-byte bytes) literal and cross-line rules take 0.1-0.2
// s and whole-text line walks (^(?:.*\n)*...) 3.3 s, a third of the
// timeout (docs/progress/evidence/relational-redesign/task-12-fix-0/).
// A page of typical histories reaches 250 users first; larger histories
// only split into more pages, each still read once per rule page.
export const historyPageBudget = 800_000;

// The UTF-8 bytes of pattern text one legacy rule page may hold: the same
// 2 MB of string storage as 500 rules of 2,000 characters, while one
// pattern may use all of it. The planner cuts rule pages by rows and by
// these bytes, so no existing pattern needs a length cap.
export const legacyPatternBudget = 1_000_000;

// The only claim domain each table source may be planned under. An
// enrollments claim plans its rules alone only while every rule is of a
// mode planned as plain rule ranges; otherwise it needs source
// `enrollments`, the one plan that covers every rule mode.
export const pageSourceDomains: Readonly<Record<PageSource, Domain>> = {
  history: 'history_index',
  rules: 'enrollments',
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
