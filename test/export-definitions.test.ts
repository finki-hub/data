import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type {
  ExportDefinition,
  RowContext,
  SourceRead,
} from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { FakeItem } from './store-test-helpers.js';

import { courses } from '../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import {
  checkDefinitions,
  definitionProblems,
  definitionReads,
} from '../directus/extensions/directus-extension-data-operations/src/exports/definitions-check.js';
import {
  readFileSources,
  serializeFile,
  type SourceReader,
} from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import {
  fileShape,
  validateFile,
} from '../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';
import { publicForm } from '../directus/extensions/directus-extension-data-operations/src/exports/values.js';
import { snapshotFields } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { findModelCollection } from '../src/data-model/collections.js';
import { aliasesFor, findModelRelation } from '../src/data-model/relations.js';
import {
  engineDefinitions as exportDefinitions,
  rooms,
  staff,
} from './fixtures/sample-exports.js';
import { forbiddenPrivateFields } from './fixtures/synthetic-data.js';
import { storeReader } from './memory-reader.js';
import {
  edit,
  importedStore,
  injecting,
  refusalOf,
  roomCapacity,
  rowsOf,
} from './relational-export-helpers.js';

const publicRows = (body: string) =>
  z.array(z.record(z.string(), z.string())).parse(JSON.parse(body));

// Every read the export layer makes.
const everyRead = exportDefinitions.flatMap((definition) =>
  definitionReads(definition),
);

// The collection a relational step reaches: the target of an M2O field,
// or the rows (junction rows for an M2M) an O2M or M2M alias lists.
const stepTarget = (collection: string, head: string): string | undefined => {
  const relation = findModelRelation(collection, head);
  if (relation !== undefined) {
    return relation.related;
  }
  const model = findModelCollection(collection);
  return model === undefined
    ? undefined
    : aliasesFor(model.collection).find(({ alias }) => alias.field === head)
        ?.relation.collection;
};

// Whether a field path exists in the data model: every step but the last
// a relation, the last a field of the collection it reaches (or id).
const pathExists = (collection: string, path: string): boolean => {
  const [head = '', ...rest] = path.split('.');
  if (rest.length > 0) {
    const target = stepTarget(collection, head);
    return target !== undefined && pathExists(target, rest.join('.'));
  }
  return (
    head === 'id' ||
    (findModelCollection(collection)?.fields.some(
      ({ field }) => field === head,
    ) ??
      false)
  );
};

// Every field path a filter names, operators and logical groups skipped.
const filterPaths = (filter: unknown, prefix = ''): string[] => {
  if (Array.isArray(filter)) {
    return filter.flatMap((inner) => filterPaths(inner, prefix));
  }
  if (typeof filter !== 'object' || filter === null) {
    return [];
  }
  return Object.entries(filter).flatMap(([key, inner]) => {
    if (key.startsWith('_')) {
      return key === '_and' || key === '_or' ? filterPaths(inner, prefix) : [];
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const deeper = filterPaths(inner, path);
    return deeper.length === 0 ? [path] : deeper;
  });
};

// The collections the export layer may read (an allowlist: a collection
// added to the model is private until listed here), each with the only
// fields it may touch where the collection holds private or internal
// columns (null allows every field the other rules allow). A dot path is
// checked at every collection it passes through.
const readable: Readonly<Record<string, null | readonly string[]>> = {
  academic_years: ['id', 'label', 'published'],
  bachelor_thesis_staff: null,
  bachelor_theses: null,
  course_accreditation_staff: null,
  course_curricula: null,
  course_enrollments: ['academic_year', 'count', 'course', 'id'],
  course_equivalencies: null,
  course_equivalency_members: ['entry', 'equivalency', 'generation', 'label'],
  course_teaching: null,
  courses: null,
  curriculum_entries: null,
  curriculum_entry_program_states: ['entry', 'program', 'state'],
  curriculum_generations: ['code', 'has_curriculum', 'id', 'published'],
  master_thesis_staff: null,
  master_theses: null,
  moodle_course_mappings: ['academic_year', 'course'],
  rooms: null,
  staff: null,
  student_council: ['id', 'student'],
  students: ['id', 'index_number', 'name'],
  study_programs: ['code', 'generation', 'id', 'published'],
  teaching_assignments: null,
  timetables: ['date_from', 'recent'],
};

// Every (collection, field) a path touches: each M2O step and the last
// field of the collection it reaches.
const touched = (
  collection: string,
  path: string,
): ReadonlyArray<readonly [string, string]> => {
  const [head = '', ...rest] = path.split('.');
  const here: readonly [string, string] = [collection, head];
  const target = rest.length > 0 ? stepTarget(collection, head) : undefined;
  return target === undefined
    ? [here]
    : [here, ...touched(target, rest.join('.'))];
};

const outsideAllowlist = ([collection, field]: readonly [string, string]) => {
  const fields = readable[collection];
  return fields === undefined || (fields !== null && !fields.includes(field));
};

const moodleUserFields: ReadonlySet<string> = new Set(snapshotFields);

const wildcardOrSome = /"_(?:none|some)"|"\*"/u;
const overBound = /^room-capacity\.json: \d+ bytes, max 4096$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

const namesMoodleField = (path: string): boolean =>
  path.split('.').some((step) => moodleUserFields.has(step));

// The labels the export layer reads: the academic year's, the key of the
// published-year rule, and an equivalency member's literal course label,
// which readiness filters on (never a Moodle history label).
const yearLabel = (read: SourceRead, path: string): boolean =>
  path === 'academic_year.label' ||
  (read.collection === 'academic_years' && path === 'label') ||
  (read.collection === 'course_equivalency_members' && path === 'label');

// What a read may not touch: a collection or field outside the
// allowlist, a Moodle user field, the private student grouping, any label
// but the academic year's, a wildcard or _some/_none.
const privateReadsOf = ([label, read]: readonly [string, SourceRead]) => {
  const paths = [...read.fields, ...filterPaths(read.filter)];
  return [
    ...(readable[read.collection] === undefined ? [read.collection] : []),
    ...paths
      .flatMap((path) => touched(read.collection, path))
      .filter((step) => outsideAllowlist(step))
      .map(([collection, field]) => `${collection}.${field}`),
    ...paths.filter((path) => namesMoodleField(path)),
    ...paths.filter((path) => path.endsWith('source_group')),
    ...paths.filter((path) => path.endsWith('label') && !yearLabel(read, path)),
    ...(wildcardOrSome.test(JSON.stringify(read)) ? ['* or _some'] : []),
  ].map((problem) => `${label}: ${problem}`);
};

// A sort path's leading `-` (descending).
const descending = /^-/u;

const missingPathsOf = ([label, read]: readonly [string, SourceRead]) =>
  [
    ...read.fields,
    ...filterPaths(read.filter),
    ...read.sort.map((path) => path.replace(descending, '')),
  ]
    .filter((path) => !pathExists(read.collection, path))
    .map((path) => `${label}: ${path}`);

// Rooms beyond the fixture's three, enough to pass a 4 KiB bound.
const extraRooms = (rows: FakeItem[]): FakeItem[] => [
  ...rows,
  ...Array.from({ length: 80 }, (_, index) => ({
    capacity: index,
    id: 100 + index,
    name: `Synthetic Extra Room ${index}`,
  })),
];

describe('the shipped export definitions', () => {
  test('are well formed', () => {
    expect(definitionProblems(exportDefinitions)).toEqual([]);
    expect(() => {
      checkDefinitions(exportDefinitions);
    }).not.toThrow();
  });

  test('read only fields and filter paths the data model has', () => {
    expect(everyRead.flatMap(missingPathsOf)).toEqual([]);
  });

  test('never read Moodle users, a private collection or a private field', () => {
    expect(everyRead.flatMap(privateReadsOf)).toEqual([]);
    // The checker itself sees each kind of private read.
    expect(
      privateReadsOf([
        'probe',
        {
          collection: 'moodle_users',
          fields: ['Mail', 'label', 'source_group', '*'],
          sort: [],
        },
      ]),
    ).toEqual([
      'probe: moodle_users',
      'probe: moodle_users.Mail',
      'probe: moodle_users.label',
      'probe: moodle_users.source_group',
      'probe: moodle_users.*',
      'probe: Mail',
      'probe: source_group',
      'probe: label',
      'probe: * or _some',
    ]);
    expect(
      [
        {
          collection: 'course_enrollments',
          fields: ['id', 'computed_revision', 'computed_at'],
        },
        { collection: 'data_operations', fields: ['id'] },
        { collection: 'students', fields: ['id', 'source_group'] },
        { collection: 'moodle_course_mappings', fields: ['entry.label'] },
      ].flatMap((read, index) =>
        privateReadsOf([`probe ${index}`, { ...read, sort: [] }]),
      ),
    ).toEqual([
      'probe 0: course_enrollments.computed_revision',
      'probe 0: course_enrollments.computed_at',
      'probe 1: data_operations',
      'probe 1: data_operations.id',
      'probe 2: students.source_group',
      'probe 2: source_group',
      'probe 3: moodle_course_mappings.entry',
      'probe 3: moodle_course_entries.label',
      'probe 3: entry.label',
    ]);
  });
});

describe('the value rules', () => {
  test.each([
    ['text', 'Room 1', 'Room 1'],
    ['text', ' untrimmed ', ' untrimmed '],
    ['number', 0, '0'],
    ['number', -1, '-1'],
    ['number', 6, '6'],
    ['numeric_boolean', true, '1'],
    ['numeric_boolean', false, '0'],
    ['boolean', true, 'TRUE'],
    ['boolean', false, 'FALSE'],
  ] as const)('publishes a %s %j as %j', (rule, value, form) => {
    expect(publicForm(rule, value)).toBe(form);
  });

  test.each([
    ['text', 6],
    ['number', '6'],
    ['number', NaN],
    ['numeric_boolean', 1],
    ['boolean', 'TRUE'],
    ['text', { name: 'x' }],
  ] as const)('refuses a %s value %j of another type', (rule, value) => {
    expect(publicForm(rule, value)).toBeNull();
  });
});

const fileOf = async (definition: ExportDefinition, reader: SourceReader) => {
  const sources = await readFileSources(definition, reader);
  return validateFile(
    definition,
    serializeFile(definition, sources),
    sources.rows.length,
  );
};

describe('a new file is one definition', () => {
  test('is read, serialized and validated by the same engine', async () => {
    const store = await importedStore();
    const file = await fileOf(roomCapacity, storeReader(store));

    expect(definitionProblems([...exportDefinitions, roomCapacity])).toEqual(
      [],
    );
    expect(publicRows(file.body)).toEqual([
      { large: 'TRUE', room: 'Synthetic Room 101', seats: '24' },
      { large: 'FALSE', room: 'Synthetic Hall 2', seats: '0' },
      { room: 'Synthetic Storage' },
    ]);
    expect(file).toMatchObject({ filename: 'room-capacity.json', rows: 3 });
    expect(file.body).toBe(
      '[{"room":"Synthetic Room 101","seats":"24","large":"TRUE"},{"room":"Synthetic Hall 2","seats":"0","large":"FALSE"},{"room":"Synthetic Storage"}]',
    );
  });

  test('never publishes a key its definition does not declare', async () => {
    const reader = injecting(storeReader(await importedStore()), {
      ...forbiddenPrivateFields,
      type: 'lab',
    });
    const file = await fileOf(roomCapacity, reader);
    const keys = publicRows(file.body).flatMap((row) => Object.keys(row));

    expect(new Set(keys)).toEqual(new Set(['large', 'room', 'seats']));
  });

  test('refuses a resolver value outside its rule instead of publishing it', async () => {
    const leaky: ExportDefinition = {
      ...roomCapacity,
      fields: [
        { key: 'room', rule: 'text', value: ({ row }: RowContext) => row },
      ],
    };

    await expect(
      fileOf(leaky, storeReader(await importedStore())),
    ).rejects.toMatchObject({ code: 'EXPORT_INVALID_PAYLOAD', status: 500 });
  });

  test('is bounded by its own size limit', async () => {
    const store = edit(await importedStore(), 'rooms', extraRooms);

    const refusal = await refusalOf(() =>
      fileOf(roomCapacity, storeReader(store)),
    );

    expect(rowsOf(store, 'rooms')).toHaveLength(83);
    expect(refusal.code).toBe('EXPORT_INVALID_PAYLOAD');
    expect(refusal.message).toMatch(overBound);
  });
});

describe('payload validation', () => {
  test.each([
    [
      'an undeclared key',
      [{ Mail: 'x', name: 'Room' }],
      'rooms.json row 0: undeclared key Mail',
    ],
    [
      'a key out of order',
      [{ floor: '0', name: 'Room' }],
      'rooms.json row 0: key name out of order',
    ],
    [
      'a number instead of text',
      [{ floor: 0 }],
      'rooms.json: not a list of rows of text values',
    ],
    [
      'an empty text',
      [{ name: '' }],
      'rooms.json: not a list of rows of text values',
    ],
    ['a dropped row', [], 'rooms.json: rows 0, expected 1'],
    [
      'no list',
      { name: 'Room' },
      'rooms.json: not a list of rows of text values',
    ],
  ])('refuses %s', (_label, value, message) => {
    expect(() => validateFile(rooms, value, 1)).toThrow(message);
  });

  test('answers the body, its UTF-8 bytes and its sha256', () => {
    // Declared order: name, type, location, floor, capacity.
    const file = validateFile(
      rooms,
      [
        {
          name: 'Синтетичка сала',
          type: 'сала',
          location: 'Синтетичка зграда',
          floor: '0',
          capacity: '24',
        },
      ],
      1,
    );

    expect(file.bytes).toBe(Buffer.byteLength(file.body, 'utf8'));
    expect(file.bytes).toBeGreaterThan(file.body.length);
    expect(file.sha256).toMatch(sha256Pattern);
  });
});

const without = (
  row: Readonly<Record<string, string>>,
  key: string,
): Record<string, string> =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));

// The required entries of a definition: a fixed key by its key, a keyed
// entry by its source and suffix.
const requiredOf = (definition: ExportDefinition): readonly string[] =>
  definition.fields.flatMap((entry) => {
    if (!('required' in entry)) {
      return [];
    }
    return ['key' in entry ? entry.key : `${entry.keys} ${entry.suffix}`];
  });

describe('the keys a consumer requires', () => {
  const room = { name: 'Room', type: 'hall', location: 'Building' };
  const person = {
    name: 'Staff',
    active: '1',
    title: 'Prof.',
    position: 'Professor',
    email: 'staff@staff.example',
  };

  test.each([
    ...['name', 'title', 'position', 'email'].map((key) => ({
      definition: staff,
      key,
      row: without(person, key),
    })),
    ...['name', 'type', 'location'].map((key) => ({
      definition: rooms,
      key,
      row: without(room, key),
    })),
  ])(
    'refuses a $definition.filename row without $key, naming the row and the key',
    ({ definition, key, row }) => {
      const complete = definition === staff ? person : room;

      expect(() => validateFile(definition, [complete, row], 2)).toThrow(
        `${definition.filename} row 1: required key ${key} missing`,
      );
    },
  );

  test('requires exactly the keys the consumers read on every row', () => {
    // professors too, but for a master's course: the resolver refuses
    // its absence (teaching-export.test.ts).
    expect(requiredOf(courses)).toEqual([
      'name',
      'published_generations available',
    ]);
    expect(requiredOf(staff)).toEqual(['name', 'title', 'position', 'email']);
    expect(requiredOf(rooms)).toEqual(['name', 'type', 'location']);
    expect(exportDefinitions.flatMap(requiredOf)).toHaveLength(9);
  });

  test("refuses a courses.json row without a published generation's availability", () => {
    const shape = fileShape(courses, {
      keyRows: {
        published_generations: [
          { code: '2018', id: 2 },
          { code: '2023', id: 1 },
        ],
      },
      rows: [{}, {}],
    });
    const row = {
      name: 'Course',
      professors: 'Сите професори',
      '2023-available': 'FALSE',
    };

    expect(() =>
      validateFile(courses, [{ ...row, '2018-available': 'TRUE' }, row], shape),
    ).toThrow('courses.json row 1: required key 2018-available missing');
    expect(
      validateFile(
        courses,
        [
          { ...row, '2018-available': 'TRUE' },
          { ...row, '2018-available': 'FALSE' },
        ],
        shape,
      ).rows,
    ).toBe(2);
  });
});

describe('the definition rules', () => {
  const broken = (change: Partial<ExportDefinition>) =>
    definitionProblems([{ ...roomCapacity, ...change }]);

  test.each([
    [{ filename: 'Room Capacity.json' }, 'is not a root-level JSON filename'],
    [{ filename: '../rooms.json' }, 'is not a root-level JSON filename'],
    [{ orderBy: 'sort' }, 'orders by sort, which its read omits'],
    [
      { rows: { ...roomCapacity.rows, fields: ['id', 'name'] } },
      'key seats reads capacity, which is omitted',
    ],
    [
      {
        rows: { ...roomCapacity.rows, fields: ['id', 'name', 'capacity', '*'] },
      },
      'read rows selects a wildcard',
    ],
    [
      {
        rows: {
          ...roomCapacity.rows,
          filter: { location: { _some: { name: { _eq: 'x' } } } },
        },
      },
      'read rows filters with _some or _none',
    ],
    [
      {
        fields: [
          { key: 'room', rule: 'text', value: 'name' },
          { key: 'room', rule: 'text', value: 'name' },
        ],
      },
      'declares a key twice',
    ],
    [
      {
        related: {
          links: { by: 'room', collection: 'rooms', fields: ['id'], sort: [] },
        },
      },
      'read links groups by an omitted field',
    ],
    [{ maxBytes: 0 }, 'has no positive size bound'],
    [
      {
        fields: [
          {
            blocks: 'published_generations',
            layouts: { byKey: {}, default: [] },
          },
        ],
      },
      'blocks published_generations without a default layout',
    ],
    [
      {
        fields: [
          {
            blocks: 'published_generations',
            layouts: {
              byKey: {},
              default: [
                { rule: 'text', suffix: 'name', value: (): null => null },
                { rule: 'text', suffix: 'name', value: (): null => null },
              ],
            },
          },
        ],
      },
      'blocks published_generations with a part twice',
    ],
    [
      {
        fields: [
          {
            blocks: 'published_generations',
            layouts: {
              byKey: {},
              default: [
                {
                  infix: 'state',
                  nested: 'published_years',
                  rule: 'text',
                  value: (): null => null,
                },
              ],
            },
          },
        ],
      },
      'blocks published_generations with an empty or unnested part',
    ],
  ] as const)('names %j', (change, problem) => {
    expect(broken(change).join('; ')).toContain(problem);
  });

  test('refuses two files of one name before anything is read', () => {
    expect(() => {
      checkDefinitions([rooms, rooms]);
    }).toThrow('two definitions publish the same filename');
  });
});
