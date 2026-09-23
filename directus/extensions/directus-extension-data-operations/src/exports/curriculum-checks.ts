import type { Filter } from '@directus/types';

import type {
  IssueCounts,
  ReadinessCheck,
  SourceRead,
  SourceRows,
} from './types.js';

import { sourceRows } from './values.js';

// The curriculum checks of courses.json, as native reads of ids and keys
// counted in code; whether a text column holds a label is a filter, never
// a read value. The projection publishes a generation's values only
// through the course's link of that generation, while the checkpoint
// serializer published some of them straight from import columns. A value
// the import carried that no link holds would leave the public file
// silently, so it blocks until the link exists or the imported value is
// cleared.

// A text column holding a non-empty value.
const filled = (field: string): Filter => ({
  _and: [{ [field]: { _nnull: true } }, { [field]: { _neq: '' } }],
});

// Every course_curricula link, as its course and generation.
const links: SourceRead = {
  collection: 'course_curricula',
  fields: ['course', 'generation'],
  sort: ['id'],
};

const pairOf = (course: unknown, generation: unknown): string =>
  `${String(course)}/${String(generation)}`;

const linkedPairs = (sources: SourceRows): ReadonlySet<string> =>
  new Set(
    sourceRows(sources, 'links').map((link) =>
      pairOf(link['course'], link['generation']),
    ),
  );

// A course an equivalency names for its 2018 values, through a 2018 entry
// or through a 2018 label that matched no entry, while the course has
// neither a 2018 link nor a name_2018_override: the checkpoint derivation
// published the 2018 name of that equivalency, the link that would carry
// it is missing.
export const curriculumCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const linked = linkedPairs(sources);
    const overridden = new Set(
      sourceRows(sources, 'overridden').map(({ id }) => id),
    );
    const named = [
      ...sourceRows(sources, 'entries'),
      ...sourceRows(sources, 'labels'),
    ].map((row) => row['course']);
    return {
      curriculum_link_unresolved: new Set(
        named.filter(
          (course) =>
            !overridden.has(course) && !linked.has(pairOf(course, '2018')),
        ),
      ).size,
    };
  },
  reads: {
    entries: {
      collection: 'course_equivalencies',
      fields: ['course'],
      filter: {
        _and: [{ course: { _nnull: true } }, { entry_2018: { _nnull: true } }],
      },
      sort: ['id'],
    },
    labels: {
      collection: 'course_equivalencies',
      fields: ['course'],
      filter: {
        _and: [
          { course: { _nnull: true } },
          { entry_2018: { _null: true } },
          filled('course_2018'),
        ],
      },
      sort: ['id'],
    },
    links,
    overridden: {
      collection: 'courses',
      fields: ['id'],
      filter: filled('name_2018_override'),
      sort: ['id'],
    },
  },
};

// The import columns of each generation on courses and what the checkpoint
// serializer published from them: name_2023 as 2023-name, credits_Y and
// available_Y as Y-credits and Y-available. A new column pair is one entry.
const importColumns = [
  {
    generation: '2023',
    label: 'name_2023',
    values: ['credits_2023', 'available_2023'],
  },
  {
    generation: '2018',
    label: null,
    values: ['credits_2018', 'available_2018'],
  },
] as const;

const labelled = importColumns.flatMap(({ label }) =>
  label === null ? [] : [label],
);

// A course carrying an imported name, credits or availability of a
// generation it has no link of: the checkpoint published that value, the
// projection has nothing to publish it from. Linking the entry, or
// clearing the imported value once the loss is intended, resolves it.
export const importedValuesCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const linked = linkedPairs(sources);
    const unlinked = new Set<unknown>();
    for (const { generation, label, values } of importColumns) {
      const carrying = [
        ...sourceRows(sources, 'values').filter((row) =>
          values.some(
            (field) => row[field] !== null && row[field] !== undefined,
          ),
        ),
        ...(label === null ? [] : sourceRows(sources, label)),
      ];
      for (const { id } of carrying) {
        if (!linked.has(pairOf(id, generation))) {
          unlinked.add(id);
        }
      }
    }
    return { curriculum_value_unlinked: unlinked.size };
  },
  reads: {
    ...Object.fromEntries(
      labelled.map((label): [string, SourceRead] => [
        label,
        {
          collection: 'courses',
          fields: ['id'],
          filter: filled(label),
          sort: ['id'],
        },
      ]),
    ),
    links,
    values: {
      collection: 'courses',
      fields: ['id', ...importColumns.flatMap(({ values }) => values)],
      sort: ['id'],
    },
  },
};
