import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileFunction, createContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { courses as coursesDefinition } from '../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import { fileKeys } from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import { deriveCourses } from '../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import {
  academicYears,
  courseNames,
  forbiddenPrivateFields,
  injectFields,
  makeSyntheticDataset,
  privateSentinels,
  sentinelPrivateId,
  sentinelPrivateMail,
  sentinelPrivateSourceGroup,
  type SerializerInput,
  toCourseSources,
  toSerializerInput,
} from './fixtures/synthetic-data.js';

const serializerPath = join(
  import.meta.dirname,
  '..',
  'directus',
  'flows',
  'serialize-assets.cjs',
);
const serializerSource = await readFile(serializerPath, 'utf8');

type LegacySerializer = (input: unknown) => unknown;
type ModuleShell = { exports: unknown };
type SandboxLoader = (module: ModuleShell) => void;

const isLegacySerializer = (value: unknown): value is LegacySerializer =>
  typeof value === 'function';

const isSandboxLoader = (value: unknown): value is SandboxLoader =>
  typeof value === 'function';

// Mirrors the Directus Run Script isolation: the serializer body is compiled
// as a CommonJS-style wrapper inside a fresh context, so it sees a module
// shell and nothing else (no require, no process, no timers).
const compileInSandbox = (source: string): SandboxLoader => {
  const loader: unknown = compileFunction(source, ['module'], {
    filename: serializerPath,
    parsingContext: createContext({}),
  });
  if (!isSandboxLoader(loader)) {
    throw new TypeError('Sandbox compilation did not produce a loader');
  }

  return loader;
};

const runLegacySerializer = (input: unknown): unknown => {
  const sandboxModule: ModuleShell = { exports: {} };
  compileInSandbox(serializerSource)(sandboxModule);
  const serialize = sandboxModule.exports;
  if (!isLegacySerializer(serialize)) {
    throw new TypeError('serialize-assets.cjs must export a function');
  }

  return serialize(input);
};

const rowSchema = z.record(z.string(), z.unknown());
const assetsSchema = z.looseObject({
  courses: z.array(rowSchema),
  rooms: z.array(rowSchema),
  staff: z.array(rowSchema),
  students: z.array(rowSchema),
});

type SerializedAssets = z.infer<typeof assetsSchema>;
type SerializedRow = z.infer<typeof rowSchema>;

const serializeLegacyFixture = (
  input: unknown = toSerializerInput(makeSyntheticDataset()),
): SerializedAssets => assetsSchema.parse(runLegacySerializer(input));

type FieldMap = ReadonlyArray<readonly [string, string]>;
type PublicCollection = 'courses' | 'rooms' | 'staff' | 'students';
type RawRow = Readonly<Record<string, unknown>>;

const emptyReads = {
  read_courses: [],
  read_rooms: [],
  read_staff: [],
  read_students: [],
} as const;

const serializeRows = (
  collection: PublicCollection,
  rows: readonly RawRow[],
): readonly SerializedRow[] =>
  serializeLegacyFixture({ ...emptyReads, [`read_${collection}`]: rows })[
    collection
  ];

const serializeRow = (
  collection: PublicCollection,
  row: RawRow,
): SerializedRow | undefined => serializeRows(collection, [row])[0];

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }

  return new Error('nothing was thrown');
};

const withoutKey = (key: string): RawRow =>
  Object.fromEntries(
    Object.entries(emptyReads).filter(([candidate]) => candidate !== key),
  );

const happyInput = (): SerializerInput =>
  toSerializerInput(makeSyntheticDataset());

// The Flow reads with fields: ['*'], so private columns ride along on every row.
const injectedInput = (): SerializerInput =>
  injectFields(happyInput(), forbiddenPrivateFields);

// Yields a non-empty string for any property the serializer reads.
const answerEveryField: RawRow = new Proxy<RawRow>(
  {},
  {
    get: (_target, property) =>
      typeof property === 'string' ? `value:${property}` : undefined,
  },
);

const courseFieldMap: FieldMap = [
  ['name', 'name'],
  ['professors', 'professors'],
  ...academicYears.map(
    (year) => [`enrollment_${year.replace('/', '_')}`, year] as const,
  ),
  ['available_2023', '2023-available'],
  ['available_2018', '2018-available'],
  ['channel', 'channel'],
  ['tags', 'tags'],
  ['assistants', 'assistants'],
  ['name_2023', '2023-name'],
  ['code_2023', '2023-code'],
  ['level_2023', '2023-level'],
  ['semester_2023', '2023-semester'],
  ['channel_2023', '2023-channel'],
  ['prerequisite_2023', '2023-prerequisite'],
  ['state_kn_2023', '2023-state-kn'],
  ['state_siis_2023', '2023-state-siis'],
  ['state_pit_2023', '2023-state-pit'],
  ['state_imb_2023', '2023-state-imb'],
  ['state_ki_2023', '2023-state-ki'],
  ['state_ie_2023', '2023-state-ie'],
  ['state_ssp_2023', '2023-state-ssp'],
  ['state_seis_2023', '2023-state-seis'],
  ['credits_2023', '2023-credits'],
  ['name_2018', '2018-name'],
  ['code_2018', '2018-code'],
  ['level_2018', '2018-level'],
  ['semester_2018', '2018-semester'],
  ['channel_2018', '2018-channel'],
  ['prerequisite_2018', '2018-prerequisite'],
  ['credits_2018', '2018-credits'],
  ['state_kn_2018', '2018-state-kn'],
  ['state_siis_2018', '2018-state-siis'],
  ['state_pit_2018', '2018-state-pit'],
  ['state_imb_2018', '2018-state-imb'],
  ['state_ki_2018', '2018-state-ki'],
  ['state_ke_2018', '2018-state-ke'],
  ['state_seis_2018', '2018-state-seis'],
];

const staffFieldMap: FieldMap = [
  ['name', 'name'],
  ['active', 'active'],
  ['title', 'title'],
  ['position', 'position'],
  ['email', 'email'],
  ['cabinet', 'cabinet'],
  ['profile', 'profile'],
  ['courses', 'courses'],
  ['consultations', 'consultations'],
];

const roomFieldMap: FieldMap = [
  ['name', 'name'],
  ['type', 'type'],
  ['location', 'location'],
  ['description', 'description'],
  ['floor', 'floor'],
  ['capacity', 'capacity'],
  ['mrbs', 'mrbs'],
];

const studentFieldMap: FieldMap = [
  ['index_number', 'index'],
  ['name', 'name'],
];

const fieldMaps: ReadonlyArray<readonly [PublicCollection, FieldMap]> = [
  ['courses', courseFieldMap],
  ['rooms', roomFieldMap],
  ['staff', staffFieldMap],
  ['students', studentFieldMap],
];

const outputLabels = (fieldMap: FieldMap): readonly string[] =>
  fieldMap.map(([, label]) => label);

const readResultError = {
  message: 'Expected a Directus Read Data result',
  name: 'TypeError',
};

const rebuildAndSerialize = async (): Promise<
  ReadonlyMap<string, SerializedRow>
> => {
  const dataset = makeSyntheticDataset();
  const updates = await deriveCourses(toCourseSources(dataset));
  const rebuilt = dataset.courses.map((course) => ({
    ...course,
    ...updates.find((update) => update['id'] === course.id),
  }));
  const { courses } = serializeLegacyFixture({
    ...emptyReads,
    read_courses: rebuilt,
  });

  return new Map(courses.map((row) => [String(row['name']), row]));
};

describe('legacy serializer sandbox', () => {
  test('executes the on-disk serializer against the synthetic dataset', () => {
    const dataset = makeSyntheticDataset();
    const assets = serializeLegacyFixture();

    expect(assets.courses).toHaveLength(dataset.courses.length);
    expect(assets.rooms).toHaveLength(dataset.rooms.length);
    expect(assets.staff).toHaveLength(dataset.staff.length);
    expect(assets.students).toHaveLength(dataset.students.length);
  });

  test('offers the serializer no Node globals', () => {
    const shell: ModuleShell = { exports: {} };

    compileInSandbox(
      'module.exports = [typeof require, typeof process, typeof setTimeout];',
    )(shell);

    expect(shell.exports).toEqual(['undefined', 'undefined', 'undefined']);
  });

  test('returns exactly the four public asset keys and ignores other Flow data', () => {
    const output = runLegacySerializer({
      $accountability: { user: sentinelPrivateId },
      $trigger: { collection: 'courses' },
      read_moodle_users: [{ Mail: sentinelPrivateId }],
      ...toSerializerInput(makeSyntheticDataset()),
    });

    expect(Object.keys(rowSchema.parse(output))).toEqual([
      'courses',
      'rooms',
      'staff',
      'students',
    ]);
    expect(JSON.stringify(output)).not.toContain(sentinelPrivateId);
  });

  test.each([
    ['read_courses'],
    ['read_rooms'],
    ['read_staff'],
    ['read_students'],
  ])('throws a TypeError when %s is missing', (key) => {
    expect(thrownBy(() => runLegacySerializer(withoutKey(key)))).toMatchObject(
      readResultError,
    );
  });

  test.each([[null], [{}], ['rows'], [42], [{ length: 0 }]])(
    'throws a TypeError when a read result is %j instead of an array',
    (value) => {
      expect(
        thrownBy(() =>
          runLegacySerializer({ ...emptyReads, read_staff: value }),
        ),
      ).toMatchObject(readResultError);
    },
  );
});

describe('field mapping', () => {
  test.each(fieldMaps)(
    'maps %s input fields to output labels in export order',
    (collection, fieldMap) => {
      const row = Object.fromEntries(
        fieldMap.map(([field]) => [field, `value:${field}`]),
      );

      const output = serializeRow(collection, row);

      expect(Object.keys(output ?? {})).toEqual(outputLabels(fieldMap));
      expect(output).toEqual(
        Object.fromEntries(
          fieldMap.map(([field, label]) => [label, `value:${field}`]),
        ),
      );
    },
  );

  test.each([
    ['courses', 51],
    ['staff', 9],
    ['rooms', 7],
    ['students', 2],
  ] as const)('%s exports exactly %i columns', (collection, count) => {
    // A row answering every field the serializer asks for exposes its whole
    // export list, so added or removed columns change the observed count.
    const output = serializeRow(collection, answerEveryField);

    expect(Object.keys(output ?? {})).toHaveLength(count);
    expect(fieldMaps.find(([key]) => key === collection)?.[1]).toHaveLength(
      count,
    );
  });

  test('drops every input column outside the export list', () => {
    expect(
      serializeRow('courses', {
        date_created: '2026-01-01T00:00:00Z',
        id: 7,
        name: courseNames.alpha,
        name_2018_override: 'Legacy Override',
        professors_override: 'Override Professor',
        source_group: sentinelPrivateSourceGroup,
        user_created: sentinelPrivateId,
      }),
    ).toEqual({ name: courseNames.alpha });
  });
});

describe('value omission', () => {
  test.each([
    ['null', null],
    ['an empty string', ''],
  ])('omits a field whose value is %s', (_label, value) => {
    expect(
      serializeRow('staff', { name: 'Synthetic', active: true, email: value }),
    ).toEqual({ name: 'Synthetic', active: '1' });
  });

  test('keeps an absent email key absent', () => {
    const output = serializeRow('staff', { name: 'Synthetic', active: true });

    expect(output).toEqual({ name: 'Synthetic', active: '1' });
    expect(output).not.toHaveProperty('email');
  });

  test('omits every empty column of a sparse course row', () => {
    expect(
      serializeRow('courses', {
        name: courseNames.delta,
        professors: null,
        assistants: '',
        name_2023: '',
        code_2023: null,
      }),
    ).toEqual({ name: courseNames.delta });
  });

  test('omits an empty-string student name but keeps the index', () => {
    expect(
      serializeRow('students', { index_number: 'SYN-0003', name: '' }),
    ).toEqual({ index: 'SYN-0003' });
  });
});

describe('value retention', () => {
  test('keeps false as "0" only for active, channel_2018 and channel_2023', () => {
    expect(serializeRow('staff', { name: 'x', active: false })).toEqual({
      name: 'x',
      active: '0',
    });
    expect(
      serializeRow('courses', {
        name: 'x',
        channel_2023: false,
        channel_2018: false,
      }),
    ).toEqual({ name: 'x', '2023-channel': '0', '2018-channel': '0' });
  });

  test('keeps false as "FALSE" for every other boolean column', () => {
    expect(
      serializeRow('courses', {
        name: 'x',
        available_2023: false,
        available_2018: false,
        channel: false,
      }),
    ).toEqual({
      name: 'x',
      '2023-available': 'FALSE',
      '2018-available': 'FALSE',
      channel: 'FALSE',
    });
  });

  test('keeps true as "1" for numeric booleans and "TRUE" otherwise', () => {
    expect(serializeRow('staff', { name: 'x', active: true })).toEqual({
      name: 'x',
      active: '1',
    });
    expect(
      serializeRow('courses', {
        name: 'x',
        available_2023: true,
        channel: true,
        channel_2023: true,
        channel_2018: true,
      }),
    ).toEqual({
      name: 'x',
      '2023-available': 'TRUE',
      channel: 'TRUE',
      '2023-channel': '1',
      '2018-channel': '1',
    });
  });

  test('keeps zero as the string "0"', () => {
    expect(
      serializeRow('rooms', {
        name: 'x',
        location: 'y',
        floor: 0,
        capacity: 0,
      }),
    ).toEqual({ name: 'x', location: 'y', floor: '0', capacity: '0' });
    expect(
      serializeRow('courses', {
        name: 'x',
        enrollment_2011_2012: 0,
        level_2023: 0,
        credits_2018: 0,
      }),
    ).toEqual({
      name: 'x',
      '2011/2012': '0',
      '2023-level': '0',
      '2018-credits': '0',
    });
  });

  test('converts numbers to strings', () => {
    expect(
      serializeRow('rooms', { name: 'x', floor: -1, capacity: 120 }),
    ).toEqual({ name: 'x', floor: '-1', capacity: '120' });
    expect(
      serializeRow('courses', { name: 'x', enrollment_2025_2026: 12 }),
    ).toEqual({ name: 'x', '2025/2026': '12' });
  });

  test('passes strings through without trimming or coercion', () => {
    expect(
      serializeRow('staff', {
        name: ' padded name ',
        active: true,
        title: '0',
        position: 'FALSE',
        cabinet: 'null',
      }),
    ).toEqual({
      name: ' padded name ',
      active: '1',
      title: '0',
      position: 'FALSE',
      cabinet: 'null',
    });
  });

  test('keeps staff course text as independent free text', () => {
    const [activeStaff] = makeSyntheticDataset().staff;
    const [output] = serializeLegacyFixture().staff;

    expect(output?.['courses']).toBe(activeStaff?.['courses']);
    expect(output?.['courses']).toContain('Course Missing From Courses Table');
  });
});

describe('row handling', () => {
  test('preserves input row order without sorting', () => {
    expect(
      serializeRows('students', [
        { index_number: 'SYN-0003', name: 'Third' },
        { index_number: 'SYN-0001', name: 'First' },
        { index_number: 'SYN-0002', name: 'Second' },
      ]).map((row) => row['index']),
    ).toEqual(['SYN-0003', 'SYN-0001', 'SYN-0002']);
  });

  test('returns empty arrays for empty reads', () => {
    expect(serializeLegacyFixture(emptyReads)).toEqual({
      courses: [],
      rooms: [],
      staff: [],
      students: [],
    });
  });

  test('does not mutate the input rows', () => {
    const input = toSerializerInput(makeSyntheticDataset());
    const before = JSON.stringify(input);

    serializeLegacyFixture(input);

    expect(JSON.stringify(input)).toBe(before);
  });

  test('serializes the synthetic staff rows with numeric active flags', () => {
    expect(serializeLegacyFixture().staff).toEqual([
      {
        name: 'Synthetic Staff Active',
        active: '1',
        title: 'Prof.',
        position: 'Professor',
        email: 'active.staff@staff.example',
        cabinet: 'A-101',
        profile: 'https://staff.example/profiles/active',
        courses: 'Alpha Course, Beta Course, Course Missing From Courses Table',
        consultations: 'Mondays 10:00-12:00',
      },
      {
        name: 'Synthetic Staff Inactive',
        active: '0',
        position: 'Assistant',
        courses: 'Free text; not linked to any course row',
      },
      { name: 'Synthetic Staff Minimal', active: '1' },
    ]);
  });

  test('serializes the synthetic rooms with retained zero and negative floors', () => {
    expect(serializeLegacyFixture().rooms).toEqual([
      {
        name: 'Synthetic Room 101',
        type: 'lab',
        location: 'Synthetic Building A',
        description: 'Ground floor laboratory',
        floor: '0',
        capacity: '24',
        mrbs: 'https://mrbs.example/rooms/101',
      },
      {
        name: 'Synthetic Hall 2',
        location: 'Synthetic Building B',
        floor: '2',
        capacity: '0',
      },
      {
        name: 'Synthetic Storage',
        type: 'storage',
        location: 'Synthetic Building A',
        floor: '-1',
      },
    ]);
  });

  test('serializes the synthetic students as index and name only', () => {
    expect(serializeLegacyFixture().students).toEqual([
      { index: 'SYN-0001', name: 'Synthetic Student One' },
      { index: 'SYN-0001', name: 'Synthetic Student One (Other List)' },
      { index: 'SYN-0002', name: 'Synthetic Student Two' },
      { index: 'SYN-0003' },
    ]);
  });
});

describe('private data boundary', () => {
  test('the happy input carries the students sentinel and nothing else private', () => {
    const input = JSON.stringify(happyInput());

    expect(input).toContain(sentinelPrivateSourceGroup);
    expect(input).not.toContain(sentinelPrivateId);
    expect(input).not.toContain(sentinelPrivateMail);
  });

  test.each(fieldMaps)(
    'the injected input carries every private sentinel in %s rows',
    (collection) => {
      const rows = JSON.stringify(injectedInput()[`read_${collection}`]);

      for (const sentinel of privateSentinels) {
        expect(rows).toContain(sentinel);
      }
    },
  );

  test.each([
    ['the synthetic dataset', happyInput],
    ['the injected dataset', injectedInput],
  ])('never emits a private sentinel from %s', (_label, input) => {
    const output = JSON.stringify(serializeLegacyFixture(input()));

    for (const sentinel of privateSentinels) {
      expect(output).not.toContain(sentinel);
    }
  });

  test.each(fieldMaps)(
    'injected private columns never add a key to %s rows',
    (collection, fieldMap) => {
      const input = injectedInput();
      const labels = outputLabels(fieldMap);

      const rows = serializeLegacyFixture(input)[collection];

      expect(rows).toHaveLength(input[`read_${collection}`].length);

      for (const row of rows) {
        expect(labels).toEqual(expect.arrayContaining(Object.keys(row)));
      }

      for (const sentinel of privateSentinels) {
        expect(JSON.stringify(rows)).not.toContain(sentinel);
      }

      expect(JSON.stringify(rows)).not.toContain('injected.example');
    },
  );

  test('reads input columns by field name, never by output label', () => {
    const input = injectFields(toSerializerInput(makeSyntheticDataset()), {
      '2023-name': sentinelPrivateId,
      '2025/2026': sentinelPrivateId,
      index: sentinelPrivateId,
    });

    const output = serializeLegacyFixture(input);

    expect(JSON.stringify(output)).not.toContain(sentinelPrivateId);
    expect(output.students.map((row) => row['index'])).toEqual([
      'SYN-0001',
      'SYN-0001',
      'SYN-0002',
      'SYN-0003',
    ]);
  });
});

describe('rebuilt rows through the export projection', () => {
  test('distinguishes a false channel from a missing generation channel', async () => {
    const rows = await rebuildAndSerialize();
    const zeta = rows.get(courseNames.zeta);

    expect(zeta).toMatchObject({
      channel: 'FALSE',
      '2018-channel': '0',
      '2023-semester': '6',
      '2018-name': 'Zeta Legacy',
    });
    expect(zeta).not.toHaveProperty('2023-channel');
    expect(zeta).not.toHaveProperty('2023-code');
    expect(zeta).not.toHaveProperty('professors');
  });

  test('serializes rebuilt counts and channels with the export string rules', async () => {
    const rows = await rebuildAndSerialize();
    const alpha = rows.get(courseNames.alpha);

    expect(alpha).toMatchObject({
      professors: 'Prof. Zed Alpha, Prof. Abe Alpha',
      '2025/2026': '2',
      '2024/2025': '2',
      '2023/2024': '1',
      '2011/2012': '0',
      channel: 'TRUE',
      '2023-channel': '1',
      '2018-channel': '0',
    });
    expect(alpha).not.toHaveProperty('2023-state-imb');
  });

  test('exports an unresolved course as its name, counts and channel only', async () => {
    const rows = await rebuildAndSerialize();

    expect(rows.get(courseNames.delta)).toEqual({
      name: courseNames.delta,
      ...Object.fromEntries(
        academicYears.map((year) => [year, year === '2021/2022' ? '1' : '0']),
      ),
      channel: 'FALSE',
    });
  });
});

// The academic_years rows of the fifteen checkpoint years as the published
// key source reads them (published, oldest sorting 1), in reverse order to
// show the engine orders them itself.
const checkpointYears: readonly string[] = academicYears;

const publishedYearRows = (labels: readonly string[] = checkpointYears) =>
  labels
    .map((label) => ({
      id: 100 + checkpointYears.indexOf(label),
      label,
      sort: checkpointYears.length - checkpointYears.indexOf(label),
    }))
    .toReversed();

describe('published-year keys of the relational courses definition', () => {
  test('fill exactly the reference year positions with the fifteen published years', () => {
    expect(
      fileKeys(coursesDefinition, {
        keyRows: { published_years: publishedYearRows() },
      }),
    ).toEqual(outputLabels(courseFieldMap));
  });

  test('leave out an unpublished year and nothing else', () => {
    const published = academicYears.filter((year) => year !== '2019/2020');

    expect(
      fileKeys(coursesDefinition, {
        keyRows: { published_years: publishedYearRows(published) },
      }),
    ).toEqual(
      outputLabels(courseFieldMap).filter((label) => label !== '2019/2020'),
    );
  });

  test('list the newer label first when two published years share a sort', () => {
    const keys = fileKeys(coursesDefinition, {
      keyRows: {
        published_years: [
          { id: 1, label: '2024/2025', sort: 2 },
          { id: 2, label: '2025/2026', sort: 2 },
          { id: 3, label: '2023/2024', sort: 1 },
        ],
      },
    });

    expect(keys.filter((key) => key.includes('/'))).toEqual([
      '2025/2026',
      '2024/2025',
      '2023/2024',
    ]);
  });

  test('place a newly published later year first among the year keys', () => {
    const keys = fileKeys(coursesDefinition, {
      keyRows: {
        published_years: [
          ...publishedYearRows(),
          { id: 99, label: '2026/2027', sort: 16 },
        ],
      },
    });
    const reference = outputLabels(courseFieldMap);

    expect(keys).toEqual([
      ...reference.slice(0, 2),
      '2026/2027',
      ...reference.slice(2),
    ]);
  });
});
