import type { PageRange } from '../page-state.js';

// The enumerated work domains, in dependency order: the history index feeds
// the enrollment counts, and publication reads everything.
export const coordinationDomains = [
  'history_index',
  'enrollments',
  'publication',
] as const;

export type Domain = (typeof coordinationDomains)[number];

// What a claim may run: a work domain, or the promotion of a staged Moodle
// snapshot. A snapshot claim is never pending, never dirty and never
// completed through `complete`; the promotion takes and clears it itself.
export const claimDomains = [...coordinationDomains, 'snapshot'] as const;

export type ClaimDomain = (typeof claimDomains)[number];

const calculationDomainList = ['history_index', 'enrollments'] as const;

export type CalculationDomain = (typeof calculationDomainList)[number];

export const calculationDomains: readonly Domain[] = calculationDomainList;

// What a claim may name: one domain, or `next_calculation`, the first
// pending calculation domain in dependency order. The scheduled Flow
// claims `next_calculation` every tick; publication is never picked that
// way, only its own Flow claims it.
export const nextCalculation = 'next_calculation';

export const claimTargets = [...coordinationDomains, nextCalculation] as const;

export type ClaimTarget = (typeof claimTargets)[number];

// A failure message kept in the status is cut to this many characters, so
// a caller can pass a whole failure record without a size check of its own.
export const errorMessageLength = 600;

export const pageSources = ['history', 'rules'] as const;

export type PageSource = (typeof pageSources)[number];

// What plan_pages may plan: one source table, or `enrollments`, the one
// plan of an enrollments claim that covers both rule families (mapped rule
// pages, legacy rule pages crossed with history pages, and a zero page per
// legacy rule page), so its completion never drops a family's rows.
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
// heartbeat with every plan_pages, stage_page or heartbeat call, so a live
// claim is never taken away by time alone.
export const claimStaleAfterMs = 60_000;

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
// enrollments claim plans its rules alone only while every rule is
// mapped_entries; otherwise it needs source `enrollments`, the one plan
// that covers the legacy family too.
export const pageSourceDomains: Readonly<Record<PageSource, Domain>> = {
  history: 'history_index',
  rules: 'enrollments',
};

export const maxRowsPerPage = 10_000;

export const textCollator = new Intl.Collator('en');

// Which domains a statement on each editable source table marks pending.
// Mirrors the CASE inside the finki_hub_source_invalidation trigger
// function in src/migrations/source-invalidation.sql; the unit tests keep
// the two in step. Derived, staging and status tables are absent on purpose.
export const sourceTableDomains: Readonly<Record<string, readonly Domain[]>> = {
  academic_years: ['enrollments', 'publication'],
  course_curricula: ['publication'],
  course_enrollment_patterns: ['publication'],
  course_enrollment_rules: ['enrollments', 'publication'],
  course_equivalencies: ['publication'],
  courses: ['publication'],
  curriculum_2018: ['publication'],
  curriculum_2023: ['publication'],
  curriculum_entries: ['publication'],
  deans_office: ['publication'],
  discord_channels: ['publication'],
  moodle_course_entries: ['enrollments', 'publication'],
  moodle_course_mappings: ['enrollments', 'publication'],
  moodle_users: ['history_index', 'enrollments', 'publication'],
  rooms: ['publication'],
  staff: ['publication'],
  student_council: ['publication'],
  students: ['publication'],
  teaching_assignments: ['publication'],
};

// Domains a DELETE or TRUNCATE on a source table marks on top of its usual
// ones. Deleting a history entry cascades its memberships away, so the
// derived index no longer matches the raw histories until it is rebuilt.
// Mirrors the IF block after the CASE in the trigger function.
export const sourceTableDeletionDomains: Readonly<
  Record<string, readonly Domain[]>
> = {
  moodle_course_entries: ['history_index'],
};

// Domains an UPDATE naming one of these columns marks on top of the
// table's usual ones: an entry label belongs to the index writer, so a
// label edited by hand leaves the index behind the raw histories until it
// is rebuilt. Mirrors the column trigger finki_hub_entry_label_invalidation.
export const sourceColumnDomains: Readonly<
  Record<string, Readonly<Record<string, readonly Domain[]>>>
> = {
  moodle_course_entries: { label: ['history_index'] },
};

// Checkpoint tables a later task may remove; their triggers are installed
// only while the table exists.
export const optionalSourceTables: readonly string[] = [
  'curriculum_2023',
  'curriculum_2018',
  'course_enrollment_patterns',
];

export const excludedTables: readonly string[] = [
  'moodle_history_memberships',
  'course_enrollments',
  'data_operations',
  'data_operation_results',
  'moodle_import_rows',
];

// Timestamps are ISO-8601 strings rendered by the database; the heartbeat
// age is measured by the database clock so every process judges staleness
// the same way.
export type Claim = {
  // Null only for a status row whose token survived while its other claim
  // columns did not; such a claim serves no action and is released as
  // abandoned.
  readonly domain: ClaimDomain | null;
  readonly fingerprint: string;
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
  // The outcome of each file of the last completed publication, keyed by
  // filename; null when none was recorded.
  readonly publicationOutcomes: null | Readonly<Record<string, string>>;
  readonly publicationState: string;
  readonly requestedRevision: number;
  readonly sourceRevision: number;
  readonly startedAt: null | string;
};

export const isDomain = (value: unknown): value is Domain =>
  typeof value === 'string' &&
  (coordinationDomains as readonly string[]).includes(value);

export const isClaimDomain = (value: unknown): value is ClaimDomain =>
  typeof value === 'string' &&
  (claimDomains as readonly string[]).includes(value);

// Keeps only known domains, once each, in dependency order.
export const normaliseDomains = (values: readonly unknown[]): Domain[] =>
  coordinationDomains.filter((domain) => values.includes(domain));
