import type { WorkbookItem, WorkbookKey } from '../../src/schema.js';

/**
 * Deterministic, fully invented dataset covering every part of the workbook.
 *
 * Every value is synthetic: names are Greek-letter placeholders, addresses use
 * `.example` domains only, and private-only columns carry sentinel strings so
 * tests can prove those values never reach a public output. Rows carry the
 * columns the workbook holds; what the public files hold for them is
 * committed under test/fixtures/expected-exports (test/expected-exports.ts).
 */

export type SyntheticRow = WorkbookItem & { readonly id: number };

export type SyntheticDataset = Readonly<
  Record<WorkbookKey, readonly SyntheticRow[]>
>;

// The academic years the synthetic workbook's enrollment sheet names,
// newest first, unless a test names others.
export const academicYears = [
  '2025/2026',
  '2024/2025',
  '2023/2024',
  '2022/2023',
  '2021/2022',
  '2020/2021',
  '2019/2020',
  '2018/2019',
  '2017/2018',
  '2016/2017',
  '2015/2016',
  '2014/2015',
  '2013/2014',
  '2012/2013',
  '2011/2012',
] as const;

export const sentinelPrivateId = 'SENTINEL_PRIVATE_ID';
export const sentinelPrivateMail = 'SENTINEL_PRIVATE_MAIL';
export const sentinelPrivateSourceGroup = 'SENTINEL_PRIVATE_SOURCE_GROUP';

export const privateSentinels = [
  sentinelPrivateId,
  sentinelPrivateMail,
  sentinelPrivateSourceGroup,
] as const;

export const courseNames = {
  alpha: 'Alpha Course',
  beta: 'Beta Course',
  delta: 'Delta Course',
  epsilon: 'Epsilon Course',
  gamma: 'Gamma Course',
  iota: 'Iota 2.0 Course',
  theta: 'Theta Course',
  zeta: 'Zeta Course',
} as const;

// The names of the synthetic staff rows; the teaching cells list them.
export const staffNames = {
  active: 'Synthetic Staff Active',
  inactive: 'Synthetic Staff Inactive',
  minimal: 'Synthetic Staff Minimal',
} as const;

// The texts of the two statuses that replace names in a teaching cell.
const allProfessors = 'Сите професори';
const inactiveCourse = '(неактивиран предмет)';

/** A name whose `+` makes the unescaped default enrollment pattern invalid. */
export const metacharacterCourseName = 'C++ Course';

// A course row with the workbook's columns, empty unless given.
const makeCourse = (
  id: number,
  name: string,
  values: WorkbookItem,
): SyntheticRow => ({
  id,
  name,
  typed_professors: null,
  available_2023: null,
  available_2018: null,
  tags: null,
  name_2023: null,
  credits_2023: null,
  name_2018_override: null,
  credits_2018: null,
  export_assistants: null,
  ...values,
});

const makeCurriculum2023 = (
  id: number,
  name: string,
  values: WorkbookItem,
): SyntheticRow => ({
  id,
  catalog_order: id,
  name,
  url: `https://curriculum.example/2023/${id}`,
  code: null,
  semester: null,
  prerequisites: null,
  state_kn: null,
  state_siis: null,
  state_pit: null,
  state_imb: null,
  state_ki: null,
  state_ie: null,
  state_ssp: null,
  state_seis: null,
  channel: false,
  ...values,
});

const makeCurriculum2018 = (
  id: number,
  name: string,
  values: WorkbookItem,
): SyntheticRow => ({
  id,
  catalog_order: id,
  name,
  url: `https://curriculum.example/2018/${id}`,
  code: null,
  semester: null,
  prerequisites: null,
  state_kn: null,
  state_siis: null,
  state_pit: null,
  state_imb: null,
  state_ki: null,
  state_ke: null,
  state_seis: null,
  channel: false,
  ...values,
});

const makeMoodleUser = (
  id: number,
  courses: null | string,
  coursesCount: null | number,
): SyntheticRow => {
  const label = String(id).padStart(3, '0');

  return {
    id,
    ID_old: 1_000 + id,
    ID_new: 2_000 + id,
    Name: `Synthetic Moodle User ${label}`,
    Mail: `${sentinelPrivateMail}.${label}@moodle-users.example`,
    Courses: courses,
    'Courses Count': coursesCount,
    Profile_old: `https://moodle-old.example/user/profile.php?id=${sentinelPrivateId}-old-${label}`,
    Profile_new: `https://moodle.example/user/profile.php?id=${sentinelPrivateId}-new-${label}`,
    AIM_new: `synthetic-aim-new-${label}`,
    AIM_old: `synthetic-aim-old-${label}`,
    Avatar_new: `https://moodle.example/avatars/synthetic-new-${label}.png`,
    Avatar_old: `https://moodle-old.example/avatars/synthetic-old-${label}.png`,
    City_new: 'Synthetic City (new)',
    City_old: 'Synthetic City (old)',
    Country_new: 'Synthetic Country (new)',
    Country_old: 'Synthetic Country (old)',
    Description_new: `Synthetic description (new) ${label}`,
    Description_old: `Synthetic description (old) ${label}`,
    ICQ_new: `synthetic-icq-new-${label}`,
    ICQ_old: `synthetic-icq-old-${label}`,
    Images_new: `https://moodle.example/images/synthetic-new-${label}.png`,
    Images_old: `https://moodle-old.example/images/synthetic-old-${label}.png`,
    Interests_new: 'synthetic interests (new)',
    Interests_old: 'synthetic interests (old)',
    'Last Access_new': '2026-01-01 00:00',
    'Last Access_old': '2020-01-01 00:00',
    MSN_new: `synthetic-msn-new-${label}`,
    MSN_old: `synthetic-msn-old-${label}`,
    MoodleNet_new: `synthetic-moodlenet-new-${label}`,
    MoodleNet_old: `synthetic-moodlenet-old-${label}`,
    Skype_new: `synthetic-skype-new-${label}`,
    Skype_old: `synthetic-skype-old-${label}`,
    Timezone_new: 'Etc/UTC',
    Timezone_old: 'Etc/UTC',
    Web_new: `https://synthetic-web.example/new/${label}`,
    Web_old: `https://synthetic-web.example/old/${label}`,
    Yahoo_new: `synthetic-yahoo-new-${label}`,
    Yahoo_old: `synthetic-yahoo-old-${label}`,
  };
};

/**
 * Cross-newline override for Theta 2021/2022: it spans a line break, so no
 * single history line matches it and Theta counts 0 in 2021/2022, where a
 * whole-history match counted the two histories listing the lab directly
 * after the lecture (LF or CRLF).
 */
export const thetaCrossNewlinePattern = String.raw`Theta Course-2021/2022\r?\nTheta Lab-2021/2022`;

const makeCourses = (): readonly SyntheticRow[] => [
  makeCourse(1, courseNames.alpha, {
    available_2023: true,
    available_2018: false,
    tags: 'synthetic;alpha',
    name_2023: 'Alpha Course (2023)',
    credits_2023: 6,
    credits_2018: 6,
  }),
  makeCourse(2, courseNames.beta, {
    typed_professors: staffNames.active,
    available_2023: true,
    available_2018: true,
    tags: '',
    name_2023: 'Beta Course',
    credits_2023: 6,
    name_2018_override: 'Beta Legacy Manual',
    credits_2018: 0,
  }),
  makeCourse(3, courseNames.gamma, {
    typed_professors: staffNames.minimal,
    available_2023: true,
    available_2018: false,
    tags: 'synthetic;gamma',
    name_2023: 'Gamma Course',
    credits_2023: 6,
  }),
  makeCourse(4, courseNames.delta, {
    name_2023: '',
  }),
  makeCourse(5, courseNames.epsilon, {
    typed_professors: allProfessors,
    available_2023: true,
    available_2018: true,
    tags: 'synthetic;epsilon',
    name_2023: 'Epsilon Course',
    credits_2023: 6,
    name_2018_override: '',
    credits_2018: 6,
  }),
  makeCourse(6, courseNames.zeta, {
    available_2023: false,
    available_2018: false,
    name_2023: 'Zeta Course',
    credits_2023: 0,
  }),
  makeCourse(7, courseNames.theta, {
    typed_professors: '',
    available_2023: true,
    available_2018: true,
    name_2023: 'Theta Course',
    credits_2023: 6,
    credits_2018: 6,
  }),
  makeCourse(8, courseNames.iota, {
    available_2023: true,
    name_2023: 'Iota 2.0 Course',
    credits_2023: 6,
  }),
];

// Curriculum codes in FINKI's form F<yy>L<level><W or S><nnn>: the
// sheet's generation, the level the projection publishes, W for an odd
// (winter) and S for an even (summer) semester, and a serial. The
// duplicate, decoy and equivalent rows keep their marker levels 7 to 9.
const makeCurriculum2023Rows = (): readonly SyntheticRow[] => [
  makeCurriculum2023(1, 'Alpha Course (2023)', {
    code: 'F23L1W001',
    semester: 1,
    state_kn: 'mandatory',
    state_siis: 'elective',
    state_imb: '',
    state_ki: 'elective',
    state_ie: 'mandatory',
    state_ssp: 'elective',
    state_seis: 'mandatory',
    channel: true,
  }),
  makeCurriculum2023(2, 'Alpha Course (2023)', {
    code: 'F23L9W001',
    semester: 9,
    state_kn: 'duplicate-must-lose',
    channel: false,
  }),
  makeCurriculum2023(3, courseNames.alpha, {
    code: 'F23L8S900',
    semester: 8,
    state_kn: 'decoy-must-lose',
    channel: false,
  }),
  makeCurriculum2023(4, courseNames.beta, {
    code: 'F23L2W002',
    semester: 3,
    prerequisites: 'SYN23-001',
    state_kn: 'elective',
    state_siis: 'mandatory',
    channel: false,
  }),
  makeCurriculum2023(5, courseNames.gamma, {
    code: 'F23L1S003',
    semester: 2,
    state_pit: 'mandatory',
    channel: false,
  }),
  makeCurriculum2023(6, courseNames.epsilon, {
    code: 'F23L3W005',
    semester: 5,
    prerequisites: 'SYN23-002',
    state_kn: 'kn-state',
    state_siis: 'siis-state',
    state_pit: 'pit-state',
    state_imb: 'imb-state',
    state_ki: 'ki-state',
    state_ie: 'ie-state',
    state_ssp: 'ssp-state',
    state_seis: 'seis-state',
    channel: true,
  }),
  makeCurriculum2023(7, courseNames.zeta, {
    code: '',
    semester: 6,
    prerequisites: '',
    state_kn: '',
    channel: null,
  }),
  makeCurriculum2023(8, courseNames.theta, {
    code: 'F23L2S007',
    semester: 4,
    state_ki: 'mandatory',
    channel: true,
  }),
  makeCurriculum2023(9, courseNames.iota, {
    code: 'F23L1W008',
    semester: 1,
    channel: false,
  }),
  makeCurriculum2023(10, 'Orphan Current Course', {
    code: 'F23L1W999',
    semester: 1,
    channel: true,
  }),
];

const makeCurriculum2018Rows = (): readonly SyntheticRow[] => [
  makeCurriculum2018(1, 'Alpha Legacy', {
    code: 'F18L1S001',
    semester: 2,
    state_kn: 'mandatory',
    state_pit: 'elective',
    state_ke: 'elective',
    channel: false,
  }),
  makeCurriculum2018(2, 'Alpha Legacy Duplicate', {
    code: 'F18L9W001',
    semester: 9,
    channel: true,
  }),
  makeCurriculum2018(3, 'Beta Legacy Manual', {
    code: 'F18L2S002',
    semester: 4,
    prerequisites: 'SYN18-001',
    state_kn: 'elective',
    channel: true,
  }),
  makeCurriculum2018(4, 'Beta Legacy Equivalent', {
    code: 'F18L7W002',
    semester: 7,
    state_kn: 'equivalent-must-lose',
    channel: false,
  }),
  makeCurriculum2018(5, 'Epsilon Legacy', {
    code: 'F18L3S005',
    semester: 6,
    prerequisites: 'SYN18-002-MANUAL',
    state_kn: 'kn-legacy',
    state_siis: 'siis-legacy',
    state_pit: 'pit-legacy',
    state_imb: 'imb-legacy',
    state_ki: 'ki-legacy',
    state_ke: 'ke-legacy',
    state_seis: 'seis-legacy',
    channel: true,
  }),
  makeCurriculum2018(6, 'Zeta Legacy', {
    code: 'F18L1W006',
    semester: 1,
    channel: false,
  }),
  makeCurriculum2018(7, 'Theta Legacy', {
    code: 'F18L2W007',
    semester: 3,
    state_ke: 'mandatory',
    channel: false,
  }),
  makeCurriculum2018(8, 'Orphan Legacy Course', {
    code: 'F18L1W999',
    semester: 1,
    channel: true,
  }),
  makeCurriculum2018(9, 'Alpha Legacy', {
    code: 'F18L9W101',
    semester: 9,
    state_kn: 'later-duplicate-must-lose',
    channel: true,
  }),
  makeCurriculum2018(10, courseNames.alpha, {
    code: 'F18L8S900',
    semester: 8,
    state_kn: 'decoy-must-lose',
    channel: true,
  }),
];

const makeCourseEquivalencies = (): readonly SyntheticRow[] => [
  {
    id: 1,
    course_2023: courseNames.alpha,
    course_2018: 'Alpha Legacy',
    course_2013: 'Alpha Ancient',
  },
  {
    id: 2,
    course_2023: courseNames.alpha,
    course_2018: 'Alpha Legacy Duplicate',
    course_2013: null,
  },
  {
    id: 3,
    course_2023: 'Alpha Course (2023)',
    course_2018: 'Alpha Legacy Decoy',
    course_2013: null,
  },
  {
    id: 4,
    course_2023: courseNames.beta,
    course_2018: 'Beta Legacy Equivalent',
    course_2013: 'Beta Ancient',
  },
  {
    id: 5,
    course_2023: courseNames.gamma,
    course_2018: null,
    course_2013: 'Gamma Ancient',
  },
  {
    id: 6,
    course_2023: courseNames.epsilon,
    course_2018: 'Epsilon Legacy',
    course_2013: null,
  },
  {
    id: 7,
    course_2023: courseNames.zeta,
    course_2018: 'Zeta Legacy',
    course_2013: null,
  },
  {
    id: 8,
    course_2023: courseNames.theta,
    course_2018: 'Theta Legacy',
    course_2013: 'Theta Ancient',
  },
  {
    id: 9,
    course_2023: 'Orphan Equivalent Course',
    course_2018: 'Orphan Legacy Course',
    course_2013: 'Orphan Ancient',
  },
  { id: 10, course_2023: null, course_2018: null, course_2013: 'Ancient Only' },
];

// One staff name per line. Alpha's second row and the orphan row are
// never read; Beta's and Epsilon's rows are superseded by their typed
// export cells.
const makeTeachingAssignments = (): readonly SyntheticRow[] => [
  {
    id: 1,
    course_name: courseNames.alpha,
    professors: `${staffNames.minimal}\n${staffNames.active}`,
    assistants: staffNames.inactive,
  },
  {
    id: 2,
    course_name: courseNames.alpha,
    professors: 'Prof. Later Alpha',
    assistants: 'Asst. Later Alpha',
  },
  {
    id: 3,
    course_name: courseNames.beta,
    professors: 'Prof. Beta Assigned',
    assistants: 'Asst. Beta Assigned',
  },
  {
    id: 4,
    course_name: courseNames.epsilon,
    professors: 'Prof. Epsilon',
    assistants: null,
  },
  {
    id: 5,
    course_name: courseNames.zeta,
    professors: allProfessors,
    assistants: staffNames.minimal,
  },
  {
    id: 6,
    course_name: 'Orphan Assignment Course',
    professors: 'Prof. Orphan',
    assistants: 'Asst. Orphan',
  },
  {
    id: 7,
    course_name: courseNames.theta,
    professors: staffNames.minimal,
    assistants: staffNames.active,
  },
  {
    id: 8,
    course_name: courseNames.iota,
    professors: `${staffNames.active}\n${staffNames.inactive}\n${staffNames.active}`,
    assistants: staffNames.minimal,
  },
  {
    id: 9,
    course_name: courseNames.delta,
    professors: inactiveCourse,
    assistants: inactiveCourse,
  },
];

const makeCourseEnrollmentPatterns = (): readonly SyntheticRow[] => [
  {
    id: 1,
    course_name: courseNames.alpha,
    academic_year: '2025/2026',
    pattern: 'Alpha Course-2025/2026',
  },
  {
    id: 2,
    course_name: courseNames.alpha,
    academic_year: '2025/2026',
    pattern: 'Alpha Honors-2025/2026',
  },
  {
    id: 3,
    course_name: courseNames.theta,
    academic_year: '2021/2022',
    pattern: thetaCrossNewlinePattern,
  },
  {
    id: 4,
    course_name: 'Omega Orphan Course',
    academic_year: '2020/2021',
    pattern: 'Omega Orphan Course-2020/2021',
  },
];

const makeMoodleUsers = (): readonly SyntheticRow[] => [
  makeMoodleUser(
    1,
    'Alpha Course-2025/2026\nAlpha Course-2024/2025\nBeta Course-2024/2025',
    3,
  ),
  makeMoodleUser(
    2,
    'Alpha Honors-2025/2026\r\nBeta Course-2024/2025\r\nEpsilon Course-2023/2024',
    3,
  ),
  makeMoodleUser(
    3,
    'Alpha Course-2024/2025\nAlpha Course-2024/2025\nAlpha Honors-2025/2026',
    42,
  ),
  makeMoodleUser(4, 'Theta Course-2021/2022\nTheta Lab-2021/2022', 2),
  makeMoodleUser(5, 'Theta Course-2021/2022\r\nTheta Lab-2021/2022', 2),
  makeMoodleUser(
    6,
    'Theta Course-2021/2022\nDelta Course-2021/2022\nTheta Lab-2021/2022',
    3,
  ),
  makeMoodleUser(7, null, null),
  makeMoodleUser(
    8,
    'Advanced Alpha Course-2023/2024\nIota 2X0 Course-2022/2023',
    2,
  ),
  makeMoodleUser(9, '', 0),
];

const makeStaff = (): readonly SyntheticRow[] => [
  {
    id: 1,
    name: staffNames.active,
    active: true,
    title: 'Prof.',
    position: 'Professor',
    email: 'active.staff@staff.example',
    cabinet: 'A-101',
    profile: 'https://staff.example/profiles/active',
    courses: 'Alpha Course, Beta Course, Course Missing From Courses Table',
    consultations: 'Mondays 10:00-12:00',
  },
  {
    id: 2,
    name: staffNames.inactive,
    active: false,
    title: 'Asst.',
    position: 'Assistant',
    email: 'inactive.staff@staff.example',
    cabinet: '',
    profile: '',
    courses: 'Free text; not linked to any course row',
    consultations: null,
  },
  {
    id: 3,
    name: staffNames.minimal,
    active: true,
    title: 'Prof.',
    position: 'Professor',
    email: 'minimal.staff@staff.example',
    cabinet: null,
    profile: null,
    courses: null,
    consultations: null,
  },
];

const makeRooms = (): readonly SyntheticRow[] => [
  {
    id: 1,
    name: 'Synthetic Room 101',
    type: 'lab',
    location: 'Synthetic Building A',
    description: 'Ground floor laboratory',
    floor: 0,
    capacity: 24,
    mrbs: 'https://mrbs.example/rooms/101',
  },
  {
    id: 2,
    name: 'Synthetic Hall 2',
    type: 'hall',
    location: 'Synthetic Building B',
    description: '',
    floor: 2,
    capacity: 0,
    mrbs: null,
  },
  {
    id: 3,
    name: 'Synthetic Storage',
    type: 'storage',
    location: 'Synthetic Building A',
    description: '',
    floor: -1,
    capacity: null,
    mrbs: '',
  },
];

const makeStudents = (): readonly SyntheticRow[] => [
  {
    id: 1,
    index_number: 'SYN-0001',
    name: 'Synthetic Student One',
    source_group: `${sentinelPrivateSourceGroup}:year-list`,
  },
  {
    id: 2,
    index_number: 'SYN-0001',
    name: 'Synthetic Student One (Other List)',
    source_group: `${sentinelPrivateSourceGroup}:other-list`,
  },
  {
    id: 3,
    index_number: 'SYN-0002',
    name: 'Synthetic Student Two',
    source_group: `${sentinelPrivateSourceGroup}:year-list`,
  },
  {
    id: 4,
    index_number: 'SYN-0003',
    name: '',
    source_group: `${sentinelPrivateSourceGroup}:other-list`,
  },
];

const makeDiscordChannels = (): readonly SyntheticRow[] => [
  {
    id: 1,
    semester: 1,
    channel: 'gamma-and-delta',
    course_names: 'Gamma Course / Delta Course',
  },
  { id: 2, semester: 6, channel: 'zeta', course_names: 'Zeta Course' },
];

const makeStudentCouncil = (): readonly SyntheticRow[] => [
  {
    id: 1,
    year: 2_024,
    index_number: 'SYN-0001',
    position: 'President',
  },
  {
    id: 2,
    year: 2_024,
    index_number: 'SYN-9999',
    position: 'Member',
  },
  {
    id: 3,
    year: 2_023,
    index_number: 'SYN-0002',
    position: 'Member',
  },
  {
    id: 4,
    year: 2_023,
    index_number: 'SYN-0003',
    position: 'Member',
  },
];

const makeDeansOffice = (): readonly SyntheticRow[] => [
  { id: 1, year: 2_024, name: 'Synthetic Dean', position: 'Dean' },
  { id: 2, year: 2_024, name: 'Synthetic Vice Dean', position: 'Vice Dean' },
];

export const makeSyntheticDataset = (): SyntheticDataset => ({
  courses: makeCourses(),
  staff: makeStaff(),
  rooms: makeRooms(),
  students: makeStudents(),
  curriculum_2023: makeCurriculum2023Rows(),
  curriculum_2018: makeCurriculum2018Rows(),
  course_equivalencies: makeCourseEquivalencies(),
  teaching_assignments: makeTeachingAssignments(),
  course_enrollment_patterns: makeCourseEnrollmentPatterns(),
  discord_channels: makeDiscordChannels(),
  student_council: makeStudentCouncil(),
  deans_office: makeDeansOffice(),
  moodle_users: makeMoodleUsers(),
});

// Appends a course whose name is not a valid regular expression.
export const withMetacharacterCourse = (
  dataset: SyntheticDataset,
): SyntheticDataset => ({
  ...dataset,
  courses: [
    ...dataset.courses,
    makeCourse(99, metacharacterCourseName, { name_2023: null }),
  ],
});

/** Private-looking columns that a `fields: ['*']` read could hand to an export. */
export const forbiddenPrivateFields: WorkbookItem = {
  Mail: `${sentinelPrivateMail}@injected.example`,
  Profile_new: `https://moodle.example/user/profile.php?id=${sentinelPrivateId}`,
  source_group: sentinelPrivateSourceGroup,
  internal_note: sentinelPrivateId,
};
