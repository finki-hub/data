export const collectionDefinition = {
  collection: 'moodle_users',
  fields: [
    {
      field: 'id',
      schema: { has_auto_increment: true, is_primary_key: true },
      type: 'integer',
    },
    { field: 'Name', type: 'string' },
    { field: 'Mail', type: 'string' },
    { field: 'Profile_new', type: 'string' },
    { field: 'Profile_old', type: 'string' },
    { field: 'Courses', type: 'text' },
    { field: 'Courses Count', type: 'integer' },
  ],
  meta: { hidden: true },
  schema: {},
};

export const moodleUsers = [
  { Courses: 'Exact LF\nExclude LF', 'Courses Count': 2, Name: 'Boundary LF' },
  {
    Courses: 'Exact CRLF\r\nExact LF',
    'Courses Count': 2,
    Name: 'Boundary CRLF',
  },
  { Courses: 'Exact LF\nAnother', 'Courses Count': 2, Name: 'Boundary Starts' },
  { Courses: 'Another\r\nExact LF', 'Courses Count': 2, Name: 'Boundary Ends' },
  {
    Courses: 'Another\nExact LF\r\nThird',
    'Courses Count': 4,
    Name: 'Boundary Embedded',
  },
  { Courses: 'Exact LFx', 'Courses Count': 1, Name: 'Boundary Near' },
  {
    Courses: 'Under_score\nAnother',
    'Courses Count': 2,
    Name: 'Boundary Underscore',
  },
  { Courses: 'Under-score', 'Courses Count': 1, Name: 'Boundary Hyphen' },
  { Courses: 'UnderXscore', 'Courses Count': 1, Name: 'Boundary Wildcard' },
  { Courses: null, 'Courses Count': 0, Name: 'Boundary Null' },
  {
    Courses: 'Visible Entry',
    'Courses Count': 1,
    Mail: 'visible@example',
    Name: 'Visible Searcher',
  },
  {
    Courses: 'Hidden Entry',
    'Courses Count': 1,
    Mail: 'hidden@example',
    Name: 'Hidden Searcher',
  },
  ...Array.from({ length: 52 }, (_, index) => ({
    Courses: 'Page Entry',
    'Courses Count': index % 3,
    Mail: `page-${index + 1}@example`,
    Name: `Page ${String(index + 1).padStart(3, '0')}`,
    ...(index === 0 && {
      Profile_new: 'https://profiles.example/new',
      Profile_old: 'https://profiles.example/old',
    }),
  })),
  // 48 users with a stored count (1 to 3, so names break the ties) and
  // four without one, whose raw histories are longer than any stored
  // count: a count order puts them last in both directions.
  ...Array.from({ length: 48 }, (_, index) => ({
    Courses: 'Unscored Entry',
    'Courses Count': (index % 3) + 1,
    Name: `Unscored ${String(index + 1).padStart(3, '0')}`,
  })),
  ...['D', 'B', 'C', 'A'].map((letter) => ({
    Courses: 'Unscored Entry\nFirst\nSecond\nThird\nFourth',
    'Courses Count': null,
    Name: `Unscored Blank ${letter}`,
  })),
];
