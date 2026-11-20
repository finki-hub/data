import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type {
  ModelCollection,
  ModelField,
  ModelRelationAlias,
} from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { enumField, m2o, scalar } from '../src/data-model/fields.js';
import {
  installDataModel,
  toCollectionPayload,
} from '../src/data-model/install.js';
import { installPresentation } from '../src/data-model/presentation.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { titleCase } from '../src/data-model/title-case.js';
import {
  collectionTranslations,
  fieldTranslations,
} from '../src/data-model/translations.js';
import {
  emptyState,
  fakeDirectus,
  findCollection,
  mutations,
} from './data-model-test-helpers.js';
import { freshState } from './presentation-test-helpers.js';

// A declared label is the English (en-US) name Studio shows for a
// collection, field, alias or form group. The payloads carry
// `meta.translations` exactly when a label is declared, and the model
// declares one everywhere.

const absent = 'no translations key';

const translationsOf = (meta: Readonly<Record<string, unknown>>): unknown =>
  Object.hasOwn(meta, 'translations') ? meta['translations'] : absent;

const withLabel = (field: ModelField, label: string): ModelField => ({
  ...field,
  label,
});

// One unlabelled field of each kind, each with a note: string, boolean,
// enum, relation and a read-only JSON column.
const note = 'A note.';
const unlabelledFields: readonly ModelField[] = [
  scalar('code', 'string', { note }),
  scalar('published', 'boolean', {
    defaultValue: false,
    nullable: false,
    note,
  }),
  enumField('state', [{ label: 'Idle', value: 'idle' }], {
    defaultValue: 'idle',
    nullable: false,
    note,
  }),
  m2o('generation', 'curriculum_generations', {
    nullable: false,
    note,
    onDelete: 'NO ACTION',
    template: '{{code}}',
  }),
  scalar('outcomes', 'json', { note, readOnly: true }),
];

const unlabelledAlias: ModelRelationAlias = {
  field: 'curricula',
  fields: ['generation', 'entry'],
  template: '{{generation.code}}: {{entry.name}}',
};

const collectionBody = z.object({
  collection: z.string(),
  fields: z.array(
    z.object({
      field: z.string(),
      meta: z.record(z.string(), z.unknown()),
    }),
  ),
  meta: z.record(z.string(), z.unknown()),
});

const groupBody = z.object({
  field: z.string(),
  meta: z.record(z.string(), z.unknown()),
});

// What a `POST /collections` body sends: its translations, then per field
// and alias in payload order.
const sentTranslations = (body: unknown) => {
  const parsed = collectionBody.parse(body);
  return {
    collection: parsed.collection,
    fields: parsed.fields.map(({ field, meta }) => [
      field,
      translationsOf(meta),
    ]),
    translations: translationsOf(parsed.meta),
  };
};

// What the model declares: per collection its translations, then per field
// and alias in payload order.
const declaredTranslations = (collection: ModelCollection) => ({
  collection: collection.collection,
  fields: [
    ...collection.fields.map(({ field, label }) => [
      field,
      label === undefined ? absent : fieldTranslations(label),
    ]),
    ...aliasesFor(collection.collection).map(({ alias }) => [
      alias.field,
      alias.label === undefined ? absent : fieldTranslations(alias.label),
    ]),
  ],
  translations:
    collection.label === undefined
      ? absent
      : collectionTranslations(collection.label),
});

// Every collection, field and alias without a label, as
// `<collection>[.<field>]`.
const unlabelled = ({ collection, fields, label }: ModelCollection) => [
  ...(label === undefined ? [collection] : []),
  ...fields.flatMap((field) =>
    field.label === undefined ? [`${collection}.${field.field}`] : [],
  ),
  ...aliasesFor(collection).flatMap(({ alias }) =>
    alias.label === undefined ? [`${collection}.${alias.field}`] : [],
  ),
];

// Every label a collection declares, for itself, its fields and its
// aliases, as `<collection>[.<field>]: <label>`.
const declaredLabels = ({ collection, fields, label }: ModelCollection) => [
  ...(label === undefined
    ? []
    : [`${collection}: ${label.plural} / ${label.singular}`]),
  ...fields.flatMap((field) =>
    field.label === undefined
      ? []
      : [`${collection}.${field.field}: ${field.label}`],
  ),
  ...aliasesFor(collection).flatMap(({ alias }) =>
    alias.label === undefined
      ? []
      : [`${collection}.${alias.field}: ${alias.label}`],
  ),
];

// The collections whose field labels have tests of their own: the scraper
// fields of the Moodle users and their staging rows, and the coordination
// singleton's fields by form group.
const fieldsLabelledApart = new Set([
  'data_operations',
  'moodle_import_rows',
  'moodle_users',
]);

// Every declared label except those fields.
const labelsPinnedHere = (collection: ModelCollection) =>
  declaredLabels(
    fieldsLabelledApart.has(collection.collection)
      ? { ...collection, fields: [] }
      : collection,
  );

const labelOf = (collection: string, field: string): string | undefined =>
  findCollection(collection).fields.find(
    (candidate) => candidate.field === field,
  )?.label;

// Every field of a collection with its label, as `<field>: <label>`.
const fieldLabels = (collection: string): readonly string[] =>
  findCollection(collection).fields.map(
    ({ field, label }) => `${field}: ${String(label)}`,
  );

// A form group of the coordination singleton with its members' labels.
const groupFieldLabels = ({
  label,
  members,
}: (typeof fieldGroups)[number]): string =>
  `${label}: ${members.map((field) => String(labelOf('data_operations', field))).join('; ')}`;

// Every declared label, in model order: each collection, then its fields
// and aliases, as `<collection>[.<field>]: <label>`, without the fields
// labelled apart.
const englishLabels: readonly string[] = [
  'courses: Courses / Course',
  'courses.name: Name',
  'courses.name_en: English name',
  'courses.abbreviation: Abbreviation',
  'courses.status: Status',
  'courses.tags: Tags',
  'courses.degree_cycle: Degree cycle',
  'courses.objectives: Objectives',
  'courses.objectives_en: English objectives',
  'courses.content: Content',
  'courses.content_en: English content',
  'courses.equivalencies: Equivalencies',
  'courses.assignments: Manual teaching staff',
  'courses.discord_channels: Discord channels',
  'courses.curricula: Curriculum links',
  'courses.degree_programs: In degree programs',
  'courses.history_mappings: Moodle course links',
  'courses.pattern_mappings: Moodle patterns',
  'courses.counted_lines: Counted Moodle courses',
  'courses.enrollments: Enrollment counts',
  'courses.teaching: Taught by (timetables)',
  'courses.slots: Timetable slots',
  'courses.slot_links: All timetable slots',
  'courses.accreditation_staff: Accreditation teachers',
  'staff: Staff / Staff member',
  'staff.name: Name',
  'staff.active: Active',
  'staff.finki: FINKI staff',
  'staff.title: Title',
  'staff.position: Position',
  'staff.email: Email',
  'staff.cabinet: Office',
  'staff.profile: Profile page',
  'staff.courses: Moodle profile',
  'staff.consultations: Consultations page',
  'staff.photo: Photo',
  'staff.bio: Biography',
  'staff.council_member: Council member',
  'staff.assignments: Teaches',
  "staff.dean_terms: Dean's office terms",
  'staff.coordinated_programs: Coordinated programs',
  'staff.teaching: Teaches (timetables)',
  'staff.slots: Timetable slots',
  'staff.accreditation_courses: Accreditation courses',
  'staff.bachelor_theses: Bachelor theses',
  'staff.master_theses: Master theses',
  'staff.headed_institutes: Heads institute',
  'staff.institutes: Institutes',
  'staff.headed_centers: Heads center',
  'rooms: Rooms / Room',
  'rooms.name: Name',
  'rooms.type: Type',
  'rooms.location: Location',
  'rooms.description: Description',
  'rooms.floor: Floor',
  'rooms.capacity: Capacity',
  'rooms.mrbs: Booking page',
  'rooms.slots: Timetable slots',
  'students: Students / Student',
  'students.index_number: Index number',
  'students.name: Name',
  'students.source_group: Group',
  'students.council_memberships: Council memberships',
  'course_equivalencies: Equivalencies / Equivalency',
  'course_equivalencies.course: Course',
  'course_equivalencies.members: Members',
  'teaching_assignments: Manual teaching staff / Manual teaching assignment',
  'teaching_assignments.course: Course',
  'teaching_assignments.staff: Staff member',
  'teaching_assignments.role: Role',
  'teaching_assignments.sort: Order',
  'discord_channels: Discord channels / Discord channel',
  'discord_channels.semester: Semester',
  'discord_channels.channel: Channel',
  'discord_channels.courses: Courses',
  'discord_channel_courses: Channel courses / Channel course',
  'discord_channel_courses.discord_channel: Discord channel',
  'discord_channel_courses.course: Course',
  'student_council: Student council / Council member',
  'student_council.year: Year',
  'student_council.index_number: Index number',
  'student_council.position: Position',
  'student_council.student: Student',
  "deans_office: Dean's office / Dean's office term",
  'deans_office.year: Year',
  'deans_office.staff: Staff member',
  'deans_office.position: Position',
  'exam_sessions: Exam sessions / Exam session',
  'exam_sessions.name: Name',
  'exam_sessions.file: Schedule file',
  'anto_quotes: Anto quotes / Anto quote',
  'anto_quotes.quote: Quote',
  'academic_years: Academic years / Academic year',
  'academic_years.label: Year',
  'academic_years.published: Published',
  'academic_years.mappings: Moodle course links',
  'academic_years.pattern_mappings: Moodle patterns',
  'academic_years.enrollments: Enrollment counts',
  'curriculum_entries: Accreditation subjects / Accreditation subject',
  'curriculum_entries.generation: Accreditation',
  'curriculum_entries.name: Name',
  'curriculum_entries.catalog_order: Catalog order',
  'curriculum_entries.url: Link',
  'curriculum_entries.code: Code',
  'curriculum_entries.semester: Semester',
  'curriculum_entries.prerequisites: Prerequisites',
  'curriculum_entries.channel: Has a Discord channel',
  'curriculum_entries.course_links: Linked courses',
  'curriculum_entries.program_states: Accreditation programs',
  'curriculum_entries.equivalency_memberships: Equivalencies',
  'course_curricula: Curriculum links / Curriculum link',
  'course_curricula.course: Course',
  'course_curricula.entry: Accreditation subject',
  'course_curricula.generation: Accreditation',
  'course_curricula.credits: Credits',
  'course_curricula.available: Available',
  'curriculum_generations: Accreditations / Accreditation',
  'curriculum_generations.code: Code',
  'curriculum_generations.label: Name',
  'curriculum_generations.has_curriculum: Has a curriculum',
  'curriculum_generations.published: Published',
  'curriculum_generations.programs: Accreditation programs',
  'study_programs: Accreditation programs / Accreditation program',
  'study_programs.generation: Accreditation',
  'study_programs.code: Code',
  'study_programs.name: Name',
  'study_programs.description: Description',
  'study_programs.published: Published',
  'study_programs.degree_programs: Degree programs',
  'degree_programs: Degree programs / Degree program',
  'degree_programs.code: Code',
  'degree_programs.name: Name',
  'degree_programs.name_en: English name',
  'degree_programs.cycle: Cycle',
  'degree_programs.duration_years: Duration (years)',
  'degree_programs.accreditation: Accreditation',
  'degree_programs.language: Language',
  'degree_programs.url: Program page',
  'degree_programs.title: Degree title',
  'degree_programs.title_en: English degree title',
  'degree_programs.ects: ECTS',
  'degree_programs.coordinator: Coordinator',
  'degree_programs.description: Description',
  'degree_programs.rules: Curriculum rules',
  'degree_programs.curriculum_program: Curriculum program',
  'degree_programs.courses: Courses',
  'degree_programs.elective_slots: Elective slots',
  'degree_program_courses: Program courses / Program course',
  'degree_program_courses.program: Degree program',
  'degree_program_courses.course: Course',
  'degree_program_courses.code: Code',
  'degree_program_courses.kind: Kind',
  'degree_program_courses.semester: Semester',
  'degree_program_courses.group: Elective group',
  'degree_program_courses.group_name: Group name',
  'degree_program_courses.credits: ECTS',
  'degree_program_courses.requires: Prerequisites',
  'degree_program_slots: Elective slots / Elective slot',
  'degree_program_slots.program: Degree program',
  'degree_program_slots.semester: Semester',
  'degree_program_slots.kind: Kind',
  'degree_program_slots.count: Electives',
  'curriculum_entry_program_states: Program states / Program state',
  'curriculum_entry_program_states.entry: Accreditation subject',
  'curriculum_entry_program_states.program: Accreditation program',
  'curriculum_entry_program_states.state: State',
  'course_equivalency_members: Equivalency members / Equivalency member',
  'course_equivalency_members.equivalency: Equivalency',
  'course_equivalency_members.generation: Accreditation',
  'course_equivalency_members.label: Label',
  'course_equivalency_members.entry: Accreditation subject',
  'moodle_users: Moodle users / Moodle user',
  'moodle_users.history_memberships: Moodle courses',
  'moodle_import_rows: Snapshot staging rows / Snapshot staging row',
  'moodle_course_entries: Moodle courses / Moodle course',
  'moodle_course_entries.label: Line',
  'moodle_course_entries.first_seen: First seen',
  'moodle_course_entries.memberships: Users',
  'moodle_course_entries.mappings: Moodle course links',
  'moodle_course_entries.counted_for: Counted for',
  'moodle_history_memberships: Moodle memberships / Moodle membership',
  'moodle_history_memberships.moodle_user: Moodle user',
  'moodle_history_memberships.entry: Moodle course',
  'moodle_history_memberships.sort: Order',
  'moodle_course_mappings: Moodle course links / Moodle course link',
  'moodle_course_mappings.entry: Moodle course',
  'moodle_course_mappings.course: Course',
  'moodle_course_mappings.academic_year: Academic year',
  'moodle_left_uncounted: Left uncounted / Left uncounted Moodle course',
  'moodle_left_uncounted.entry: Moodle course',
  'moodle_left_uncounted.reason: Reason',
  'moodle_pattern_mappings: Moodle patterns / Moodle pattern',
  'moodle_pattern_mappings.course: Course',
  'moodle_pattern_mappings.pattern: Pattern',
  'moodle_pattern_mappings.year_pattern: Year pattern',
  'moodle_pattern_mappings.only_in_year: Only in year',
  'moodle_pattern_mappings.counted_lines: Moodle courses it counts',
  'moodle_counted_lines: Counted Moodle courses / Counted Moodle course',
  'moodle_counted_lines.entry: Moodle course',
  'moodle_counted_lines.course: Course',
  'moodle_counted_lines.academic_year: Academic year',
  'moodle_counted_lines.source: Counted by',
  'moodle_counted_lines.pattern_mapping: Moodle pattern',
  'data_operation_matches: Match candidates / Match candidate',
  'data_operation_matches.claim_token: Claim token',
  'data_operation_matches.page_token: Page token',
  'data_operation_matches.entry: Moodle course',
  'data_operation_matches.pattern_mapping: Moodle pattern',
  'data_operation_matches.year_label: Year',
  'course_enrollments: Enrollment counts / Enrollment count',
  'course_enrollments.course: Course',
  'course_enrollments.academic_year: Academic year',
  'course_enrollments.count: Count',
  'course_enrollments.computed_revision: Computed at revision',
  'course_enrollments.computed_at: Computed at',
  'data_operations: Data operations / Data operations',
  'timetables: Timetables / Timetable',
  'timetables.edupage_id: EduPage id',
  'timetables.title: Title',
  'timetables.date_from: Starts',
  'timetables.academic_year: Academic year',
  'timetables.term: Semester',
  'timetables.main: Main timetable',
  'timetables.recent: Published',
  'timetables.hidden: Hidden on EduPage',
  'timetables.fingerprint: Fingerprint',
  'timetables.imported_at: Imported',
  'timetables.checked_at: Last import',
  'timetables.lessons: Lessons',
  'timetables.teaching: Teaching',
  'timetables.slots: Slots',
  'timetable_lessons: Timetable lessons / Timetable lesson',
  'timetable_lessons.timetable: Timetable',
  'timetable_lessons.subject: Subject',
  'timetable_lessons.kind: Class type',
  'timetable_lessons.teacher: Teacher',
  'timetable_lessons.periods: Weekly periods',
  'timetable_lessons.course_match: Course match',
  'timetable_lessons.teacher_match: Teacher match',
  'course_teaching: Timetable teaching / Timetable teaching',
  'course_teaching.course: Course',
  'course_teaching.staff: Staff member',
  'course_teaching.timetable: Timetable',
  'course_teaching.role: Role',
  'course_teaching.periods: Weekly periods',
  'timetable_slots: Timetable slots / Timetable slot',
  'timetable_slots.timetable: Timetable',
  'timetable_slots.subject: Subject',
  'timetable_slots.kind: Class type',
  'timetable_slots.course: Course',
  'timetable_slots.day: Day',
  'timetable_slots.starts: Starts',
  'timetable_slots.ends: Ends',
  'timetable_slots.periods: Weekly periods',
  'timetable_slots.teachers: Teachers',
  'timetable_slots.groups: Classes',
  'timetable_slots.classroom: Classroom',
  'timetable_slots.room: Room',
  'timetable_slots.room_match: Room match',
  'timetable_slots.staff: Staff',
  'timetable_slots.courses: Courses',
  'timetable_slot_staff: Timetable slot staff / Timetable slot staff',
  'timetable_slot_staff.slot: Slot',
  'timetable_slot_staff.staff: Staff member',
  'timetable_slot_staff.teacher: Teacher',
  'timetable_slot_courses: Timetable slot courses / Timetable slot course',
  'timetable_slot_courses.slot: Slot',
  'timetable_slot_courses.course: Course',
  'course_aliases: Course names / Course name',
  'course_aliases.name: Timetable name',
  'course_aliases.course: Course',
  'staff_aliases: Staff names / Staff name',
  'staff_aliases.name: Timetable name',
  'staff_aliases.staff: Staff member',
  'room_aliases: Room names / Room name',
  'room_aliases.name: Timetable name',
  'room_aliases.room: Room',
  'course_accreditation_staff: Accreditation teachers / Accreditation teacher',
  'course_accreditation_staff.course: Course',
  'course_accreditation_staff.staff: Staff member',
  'course_accreditation_staff.generation: Accreditation',
  'course_accreditation_staff.sort: Order',
  'bachelor_theses: Bachelor theses / Bachelor thesis',
  'bachelor_theses.title: Title',
  'bachelor_theses.description: Abstract',
  'bachelor_theses.student_index: Index number',
  'bachelor_theses.student_name: Student',
  'bachelor_theses.status: Status',
  'bachelor_theses.submitted: Submitted',
  'bachelor_theses.year: Year',
  'bachelor_theses.file_id: Document id',
  'bachelor_theses.mentor: Mentor',
  'bachelor_theses.member_1: Committee member',
  'bachelor_theses.member_2: Second committee member',
  'bachelor_theses.imported_at: Imported',
  'bachelor_theses.committee: Staff',
  'bachelor_thesis_staff: Bachelor thesis staff / Bachelor thesis staff',
  'bachelor_thesis_staff.thesis: Thesis',
  'bachelor_thesis_staff.staff: Staff member',
  'bachelor_thesis_staff.role: Role',
  'bachelor_thesis_staff.name: Name as written',
  'bachelor_thesis_staff.year: Year',
  'master_theses: Master theses / Master thesis',
  'master_theses.title: Title',
  'master_theses.description: Abstract',
  'master_theses.student_index: Index number',
  'master_theses.student_name: Student',
  'master_theses.status: Status',
  'master_theses.presented: Defended',
  'master_theses.year: Year',
  'master_theses.file_id: Document id',
  'master_theses.mentor: Mentor',
  'master_theses.president: Committee president',
  'master_theses.member: Committee member',
  'master_theses.imported_at: Imported',
  'master_theses.committee: Staff',
  'master_thesis_staff: Master thesis staff / Master thesis staff',
  'master_thesis_staff.thesis: Thesis',
  'master_thesis_staff.staff: Staff member',
  'master_thesis_staff.role: Role',
  'master_thesis_staff.name: Name as written',
  'master_thesis_staff.year: Year',
  'institutes: Institutes / Institute',
  'institutes.name: Name',
  'institutes.page: Page',
  'institutes.head: Head',
  'institutes.imported_at: Imported',
  'institutes.members: Members',
  'institute_members: Institute members / Institute member',
  'institute_members.institute: Institute',
  'institute_members.staff: Staff member',
  'faculty_centers: Centers / Center',
  'faculty_centers.name: Name',
  'faculty_centers.page: Page',
  'faculty_centers.head: Head',
  'faculty_centers.imported_at: Imported',
  'faculty_import_issues: Faculty import issues / Faculty import issue',
  'faculty_import_issues.kind: Kind',
  'faculty_import_issues.body: Body',
  'faculty_import_issues.name: Name',
  'faculty_import_issues.email: Email',
  'faculty_import_issues.profile: Profile page',
  'faculty_import_issues.detail: Detail',
  'faculty_import_issues.imported_at: Imported',
];

// The label of every scraper field, as `<field>: <label>` in declaration
// order.
const scraperLabels: readonly string[] = [
  'ID_old: Moodle ID (old)',
  'ID_new: Moodle ID (new)',
  'Name: Name',
  'Mail: Email',
  'Courses: Course history',
  'Courses Count: Course count',
  'Profile_old: Profile (old)',
  'Profile_new: Profile (new)',
  'AIM_new: AIM (new)',
  'AIM_old: AIM (old)',
  'Avatar_new: Avatar (new)',
  'Avatar_old: Avatar (old)',
  'City_new: City (new)',
  'City_old: City (old)',
  'Country_new: Country (new)',
  'Country_old: Country (old)',
  'Description_new: Description (new)',
  'Description_old: Description (old)',
  'ICQ_new: ICQ (new)',
  'ICQ_old: ICQ (old)',
  'Images_new: Images (new)',
  'Images_old: Images (old)',
  'Interests_new: Interests (new)',
  'Interests_old: Interests (old)',
  'Last Access_new: Last access (new)',
  'Last Access_old: Last access (old)',
  'MSN_new: MSN (new)',
  'MSN_old: MSN (old)',
  'MoodleNet_new: MoodleNet (new)',
  'MoodleNet_old: MoodleNet (old)',
  'Skype_new: Skype (new)',
  'Skype_old: Skype (old)',
  'Timezone_new: Timezone (new)',
  'Timezone_old: Timezone (old)',
  'Web_new: Website (new)',
  'Web_old: Website (old)',
  'Yahoo_new: Yahoo (new)',
  'Yahoo_old: Yahoo (old)',
];

describe('field and alias labels', () => {
  test.each(unlabelledFields.map((field) => [field.kind, field] as const))(
    'adds the en-US translation of a label to the payload of an unlabelled %s field and changes nothing else',
    (_kind, field) => {
      const plain = toFieldPayload(field, 3);

      expect(toFieldPayload(withLabel(field, 'Label'), 3)).toEqual({
        ...plain,
        meta: {
          ...plain.meta,
          translations: [{ language: 'en-US', translation: 'Label' }],
        },
      });
      expect(plain.meta.note).toBe(note);
      expect(translationsOf(plain.meta)).toBe(absent);
    },
  );

  test('adds the en-US translation of a label to an alias payload and changes nothing else', () => {
    const plain = toAliasPayload(unlabelledAlias, 9);

    expect(
      toAliasPayload({ ...unlabelledAlias, label: 'Curriculum links' }, 9),
    ).toEqual({
      ...plain,
      meta: {
        ...plain.meta,
        translations: [{ language: 'en-US', translation: 'Curriculum Links' }],
      },
    });
    expect(translationsOf(plain.meta)).toBe(absent);
  });

  test('every collection, field and alias of the model declares a label', () => {
    expect(dataModelCollections.flatMap(unlabelled)).toEqual([]);
    expect(dataModelCollections.flatMap(declaredLabels)).toHaveLength(
      dataModelCollections.reduce(
        (count, { collection, fields }) =>
          count + 1 + fields.length + aliasesFor(collection).length,
        0,
      ),
    );
  });

  test('names every collection, field and alias in English, a public key by what it holds', () => {
    expect(dataModelCollections.flatMap(labelsPinnedHere)).toEqual(
      englishLabels,
    );
  });

  test('labels each scraper field once, alike in the Moodle users and the snapshot staging rows, with (old) and (new) naming the two Moodle instances', () => {
    expect(fieldLabels('moodle_import_rows')).toEqual(
      fieldLabels('moodle_users'),
    );
    expect(fieldLabels('moodle_users')).toEqual(scraperLabels);
  });

  test('labels the fields of the coordination singleton by its form groups', () => {
    expect(
      fieldGroups
        .filter(({ collection }) => collection === 'data_operations')
        .map(groupFieldLabels),
    ).toEqual([
      'Revisions: Source revision; History index input revision; Enrollment input revision; Requested revision; Completed revision; Pending domains; Calculation fingerprint',
      'Running job: Claim token; Claim owner; Claim domain; Claim revision; Claim fingerprint; Claim started; Claim heartbeat; Claim pages; Staged pages; Claim retries',
      'Last failure: Error code; Error message; Failed at; Failed revision; Failed domain; Failed fingerprint; Failed run retries',
      'Last run: Snapshot import; Started; Finished; Retries',
      'Moodle snapshot: Staged file; Staged rows; Staged fingerprint; Warnings; Error; Started; Finished; Backup file; Backup rows; Backup fingerprint; Active rows; Active fingerprint; Promoted at; Guard token',
    ]);
  });
});

describe('collection labels', () => {
  test('names a labelled collection by its plural, with its singular and plural, in en-US', () => {
    const { label, ...rest } = findCollection('courses');
    const plain = toCollectionPayload(rest);

    expect(label).toEqual({ plural: 'Courses', singular: 'Course' });
    expect(
      toCollectionPayload({
        ...rest,
        label: { plural: 'Course list', singular: 'Course item' },
      }),
    ).toEqual({
      ...plain,
      meta: {
        ...plain.meta,
        translations: [
          {
            language: 'en-US',
            plural: 'Course List',
            singular: 'Course Item',
            translation: 'Course List',
          },
        ],
      },
    });
    expect(translationsOf(plain.meta)).toBe(absent);
  });

  test('carries the labels of its fields and aliases inline', () => {
    const payload = toCollectionPayload(findCollection('courses'));
    const labels = new Map([
      ['abbreviation', 'Abbreviation'],
      ['accreditation_staff', 'Accreditation teachers'],
      ['assignments', 'Manual teaching staff'],
      ['content', 'Content'],
      ['content_en', 'English content'],
      ['counted_lines', 'Counted Moodle courses'],
      ['curricula', 'Curriculum links'],
      ['degree_cycle', 'Degree cycle'],
      ['degree_programs', 'In degree programs'],
      ['discord_channels', 'Discord channels'],
      ['enrollments', 'Enrollment counts'],
      ['equivalencies', 'Equivalencies'],
      ['history_mappings', 'Moodle course links'],
      ['name', 'Name'],
      ['name_en', 'English name'],
      ['objectives', 'Objectives'],
      ['objectives_en', 'English objectives'],
      ['pattern_mappings', 'Moodle patterns'],
      ['slot_links', 'All timetable slots'],
      ['slots', 'Timetable slots'],
      ['status', 'Status'],
      ['tags', 'Tags'],
      ['teaching', 'Taught by (timetables)'],
    ]);

    expect(
      payload.fields.map(({ field, meta }) => [field, translationsOf(meta)]),
    ).toEqual(
      [
        ...findCollection('courses').fields.map(({ field }) => field),
        ...aliasesFor('courses').map(({ alias }) => alias.field),
      ].map((field) => [
        field,
        [
          {
            language: 'en-US',
            translation: titleCase(labels.get(field) ?? ''),
          },
        ],
      ]),
    );
  });

  test('sends a translation in the install payloads exactly where the model declares a label', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    await installDataModel(request);

    const sent = mutations(requests)
      .filter(({ pathname }) => pathname === '/collections')
      .map(({ body }) => sentTranslations(body));

    expect(sent).toEqual(dataModelCollections.map(declaredTranslations));
  });
});

describe('form group labels', () => {
  test('names every form section', () => {
    expect(
      fieldGroups.map(
        ({ collection, field, label }) => `${collection}.${field}: ${label}`,
      ),
    ).toEqual([
      'courses.overview: Basics',
      'courses.curriculum: Curriculum',
      'courses.staff: Teaching',
      'courses.moodle: Moodle mappings',
      'courses.enrollment: Enrollments',
      'courses.syllabus: Syllabus',
      'moodle_course_entries.line: Moodle course',
      'moodle_course_entries.mapping: Mapping',
      'moodle_course_entries.counting: Counting',
      'moodle_course_entries.usage: Moodle users',
      'data_operations.revisions: Revisions',
      'data_operations.claim: Running job',
      'data_operations.failure: Last failure',
      'data_operations.outcomes: Last run',
      'data_operations.snapshot: Moodle snapshot',
    ]);
  });

  test('sends every group with its en-US translation', async () => {
    const { request, requests } = fakeDirectus(freshState());

    await installPresentation(request);

    const groups = new Set(
      fieldGroups.map(({ collection, field }) => `${collection}.${field}`),
    );
    const sent = mutations(requests).flatMap(({ body, method, pathname }) => {
      const collection = pathname.split('/', 3)[2];
      if (method !== 'POST' || !pathname.startsWith('/fields/')) {
        return [];
      }
      const group = groupBody.parse(body);
      return groups.has(`${String(collection)}.${group.field}`)
        ? [[`${String(collection)}.${group.field}`, translationsOf(group.meta)]]
        : [];
    });

    expect(sent).toEqual(
      fieldGroups.map(({ collection, field, label }) => [
        `${collection}.${field}`,
        fieldTranslations(label),
      ]),
    );
  });
});
