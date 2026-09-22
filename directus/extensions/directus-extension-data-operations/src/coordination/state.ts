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

export const calculationDomains: readonly Domain[] = [
  'history_index',
  'enrollments',
];

export const pageSources = ['history', 'rules'] as const;

export type PageSource = (typeof pageSources)[number];

// The only tables the page planner ever reads, keyed by the enumerated
// source names an operation may name.
export const pageSourceTables: Readonly<Record<PageSource, string>> = {
  history: 'moodle_users',
  rules: 'course_enrollment_rules',
};

export const publishedFiles = [
  'courses',
  'rooms',
  'staff',
  'students',
] as const;

export type PublishedFile = (typeof publishedFiles)[number];

export const operationId = 'finki-hub-data-coordinate';

// A claim whose heartbeat is older than this is abandoned: its process died
// or its Flow stopped without calling fail. A running job refreshes the
// heartbeat with every plan_pages, stage_page or heartbeat call, so a live
// claim is never taken away by time alone.
export const claimStaleAfterMs = 60_000;

// Every planned page covers at most this many source rows.
export const pageSize = 250;

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
  readonly lastError: LastError | null;
  readonly publicationFingerprint: null | string;
  readonly publicationState: string;
  readonly publishedFiles: Readonly<Record<PublishedFile, null | string>>;
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
