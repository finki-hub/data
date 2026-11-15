import type { Domain } from './domains.js';

// The role of every collection of the relational model, declared once.
// The source-invalidation migration is generated from the sources below;
// the excluded tables, the write guards of the schema-constraints
// migration and their Directus hooks are read from the other roles. It
// stays in code: an editable row could drop a trigger or open a guard.
export const collectionRoleNames = [
  'content',
  'source',
  'derived',
  'candidate',
  'staging',
  'status',
] as const;

export type CollectionDeclaration =
  | BookkeepingDeclaration
  | ContentDeclaration
  | GuardedDeclaration
  | SourceDeclaration;

// An UPDATE that names the column marks these domains on top of the
// table's own, through a statement trigger of this name on the column.
export type ColumnRefinement = {
  readonly domains: DomainList;
  readonly trigger: string;
};

// An editable table nothing is derived from: its statements mark no
// domain, so it carries no trigger.
export type ContentDeclaration = {
  readonly collection: string;
  readonly role: 'content';
};

export type GuardedDeclaration = {
  readonly collection: string;
  readonly guard: WriteGuard;
  readonly role: 'candidate' | 'derived' | 'staging';
};

// An editable source table: every statement on it marks `invalidates`
// inside its own transaction. `onDelete` adds domains for a DELETE or
// TRUNCATE, `columns` for an UPDATE naming a column, and `why` explains
// those refinements in the generated SQL.
// The trigger function lists a table whose domains differ from the
// default in registry order; `caseLast` lists it after the others. The
// arms name one table each, so their order changes nothing but the text.
export type SourceDeclaration = {
  readonly caseLast?: true;
  readonly collection: string;
  readonly columns?: Readonly<Record<string, ColumnRefinement>>;
  readonly invalidates: DomainList;
  readonly onDelete?: DomainList;
  readonly role: 'source';
  readonly why?: string;
};

type BookkeepingDeclaration = {
  readonly collection: string;
  readonly role: 'status';
};

// A list of domains a statement marks, never empty: an empty list would
// generate an untyped ARRAY[], which PostgreSQL cannot plan. The trigger
// function is planned lazily, so the migration would still apply and the
// first statement on the source would fail instead.
type DomainList = readonly [Domain, ...Domain[]];

// A table only its own writer changes. The database guard refuses every
// other statement unless the writer opened it for its transaction with the
// setting finki_hub.<writer>, or a foreign key cascade writes it. A writer
// of several tables opens them all with its one setting. The refusal names
// the writer (`writtenBy`); its HINT states where the rows come from
// (`hint`).
type WriteGuard = {
  readonly hint: string;
  readonly writer: string;
  readonly writtenBy: string;
};

const content = <const Collection extends string>(collection: Collection) =>
  ({ collection, role: 'content' }) as const;

// A table of the timetable import, which opens all three with one setting.
const timetableDerived = <const Collection extends string>(
  collection: Collection,
) =>
  ({
    collection,
    guard: {
      hint: 'Source: timetables-api.finki-hub.com, courses, staff, course_aliases, staff_aliases; rebuilt by: Data / Import timetables',
      writer: 'timetable_writer',
      writtenBy: 'timetable import',
    },
    role: 'derived',
  }) as const;

// Sources in the order their triggers are installed, then the others.
const collectionRoles = [
  // Every course is counted in every academic year.
  {
    collection: 'courses',
    invalidates: ['enrollments'],
    role: 'source',
  },
  content('staff'),
  content('rooms'),
  content('students'),
  content('curriculum_entries'),
  content('course_curricula'),
  content('curriculum_generations'),
  content('study_programs'),
  content('curriculum_entry_program_states'),
  content('teaching_assignments'),
  content('student_council'),
  content('course_equivalencies'),
  content('course_equivalency_members'),
  content('discord_channels'),
  content('discord_channel_courses'),
  content('deans_office'),
  content('exam_sessions'),
  content('anto_quotes'),
  content('course_aliases'),
  content('staff_aliases'),
  content('course_accreditation_staff'),
  {
    caseLast: true,
    collection: 'academic_years',
    invalidates: ['enrollments'],
    role: 'source',
  },
  {
    collection: 'moodle_users',
    invalidates: ['history_index', 'enrollments'],
    role: 'source',
  },
  {
    collection: 'moodle_course_entries',
    columns: {
      label: {
        domains: ['history_index'],
        trigger: 'finki_hub_entry_label_invalidation',
      },
    },
    invalidates: ['enrollments'],
    onDelete: ['history_index'],
    role: 'source',
    why: 'Deleting a history entry cascades its memberships away, and a label edited by hand (the label belongs to the index writer, which only inserts entries) no longer names the lines its memberships came from: either way the derived index no longer matches the raw histories until it is rebuilt. The label case arrives through the column trigger below.',
  },
  {
    collection: 'moodle_course_mappings',
    invalidates: ['enrollments'],
    role: 'source',
  },
  {
    collection: 'moodle_pattern_mappings',
    invalidates: ['enrollments'],
    role: 'source',
  },
  {
    collection: 'moodle_history_memberships',
    guard: {
      hint: 'Source: moodle_users.Courses, moodle_course_entries, moodle_course_mappings; rebuilt by: Data / Process pending',
      writer: 'history_writer',
      writtenBy: 'history index run',
    },
    role: 'derived',
  },
  {
    collection: 'course_enrollments',
    guard: {
      hint: 'Source: courses, moodle_pattern_mappings, moodle_course_mappings, moodle_users; rebuilt by: Data / Process pending',
      writer: 'enrollments_writer',
      writtenBy: 'enrollments claim completion',
    },
    role: 'derived',
  },
  // The same completion writes the lines it counts.
  {
    collection: 'moodle_counted_lines',
    guard: {
      hint: 'Source: moodle_course_entries, moodle_pattern_mappings, moodle_course_mappings; rebuilt by: Data / Process pending',
      writer: 'enrollments_writer',
      writtenBy: 'enrollments claim completion',
    },
    role: 'derived',
  },
  // The timetable import writes all three; an edit of a course, a staff
  // member or an alias rebuilds course_teaching (teaching-rebuild.ts).
  timetableDerived('timetables'),
  timetableDerived('timetable_lessons'),
  timetableDerived('course_teaching'),
  {
    collection: 'moodle_import_rows',
    guard: {
      hint: 'Written by: Data / Import Moodle snapshot',
      writer: 'snapshot_writer',
      writtenBy: 'snapshot import',
    },
    role: 'staging',
  },
  {
    collection: 'data_operations',
    role: 'status',
  },
  {
    collection: 'data_operation_matches',
    guard: {
      hint: 'Written by: coordinator',
      writer: 'candidate_writer',
      writtenBy: 'coordinator',
    },
    role: 'candidate',
  },
] as const satisfies readonly CollectionDeclaration[];

export type GuardedCollection = Extract<
  (typeof collectionRoles)[number],
  { readonly guard: WriteGuard }
>['collection'];

export type RegisteredCollection =
  (typeof collectionRoles)[number]['collection'];

export const collectionDeclarations: readonly CollectionDeclaration[] =
  collectionRoles;

export const isSource = (
  declaration: CollectionDeclaration,
): declaration is SourceDeclaration => declaration.role === 'source';

export const isGuarded = (
  declaration: CollectionDeclaration,
): declaration is GuardedDeclaration => 'guard' in declaration;

export const sourceDeclarations: readonly SourceDeclaration[] =
  collectionDeclarations.filter(isSource);

export const guardedDeclarations: readonly GuardedDeclaration[] =
  collectionDeclarations.filter(isGuarded);

export const declarationOf = (
  collection: string,
): CollectionDeclaration | undefined =>
  collectionDeclarations.find(
    (declaration) => declaration.collection === collection,
  );
