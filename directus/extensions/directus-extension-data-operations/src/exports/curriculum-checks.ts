import type { Filter } from '@directus/types';

import type {
  IssueCounts,
  ReadinessCheck,
  SourceRead,
  SourceRows,
} from './types.js';

import { pathValue, sourceRows } from './values.js';

// The curriculum checks of courses.json, as native reads of ids and keys
// counted in code; whether a text column holds a label is a filter, never
// a read value. The projection publishes a generation's values only
// through the course's link of that generation, while the checkpoint
// serializer published some of them straight from import columns and
// equivalency labels. A value the import carried that no link holds would
// leave the public file silently, so it blocks until the link exists. Both
// checks concern the historical workbook only and leave with its import
// columns in the deferred cleanup.

// A text column holding a non-empty value.
const filled = (field: string): Filter => ({
  _and: [{ [field]: { _nnull: true } }, { [field]: { _neq: '' } }],
});

// An equivalency member label of a generation with a curriculum that
// names no entry of it.
export const unlinkedMember: Filter = {
  _and: [
    filled('label'),
    { entry: { _null: true } },
    { generation: { has_curriculum: { _eq: true } } },
  ],
};

// Every course_curricula link, as its course and generation code.
const links: SourceRead = {
  collection: 'course_curricula',
  fields: ['course', 'generation.code'],
  sort: ['id'],
};

const pairOf = (course: unknown, generation: unknown): string =>
  `${String(course)}/${String(generation)}`;

const linkedPairs = (sources: SourceRows): ReadonlySet<string> =>
  new Set(
    sourceRows(sources, 'links').map((link) =>
      pairOf(link['course'], pathValue(link, 'generation.code')),
    ),
  );

// The generation whose names the checkpoint derivation took from a
// course's equivalency when no override named one (its 2018 lookup).
const equivalencyGeneration = '2018';

// A course an equivalency names through its member of that generation (an
// entry, or a label that matched none) while the course has no link of
// that generation: the checkpoint derivation published the member's name,
// the link that would carry it is missing.
export const curriculumCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const linked = linkedPairs(sources);
    const named = sourceRows(sources, 'members').map((row) =>
      pathValue(row, 'equivalency.course'),
    );
    return {
      curriculum_link_unresolved: new Set(
        named.filter(
          (course) => !linked.has(pairOf(course, equivalencyGeneration)),
        ),
      ).size,
    };
  },
  reads: {
    links,
    members: {
      collection: 'course_equivalency_members',
      fields: ['equivalency.course'],
      filter: {
        _and: [
          { equivalency: { course: { _nnull: true } } },
          { generation: { code: { _eq: equivalencyGeneration } } },
          { _or: [{ entry: { _nnull: true } }, filled('label')] },
        ],
      },
      sort: ['id'],
    },
  },
};

// The import columns of each generation on courses and what the checkpoint
// serializer published from them: name_2023 and name_2018_override as the
// generation's name, credits_Y and available_Y as Y-credits and
// Y-available. No export reads them any more.
const importColumns = [
  {
    generation: '2023',
    label: 'name_2023',
    values: ['credits_2023', 'available_2023'],
  },
  {
    generation: '2018',
    label: 'name_2018_override',
    values: ['credits_2018', 'available_2018'],
  },
] as const;

const labelled = importColumns.map(({ label }) => label);

// A course carrying an imported name, credits or availability of a
// generation it has no link of: the checkpoint published that value, the
// projection has nothing to publish it from. Linking the entry resolves
// it; an administrator can also clear the read-only imported value
// through the API once the loss is intended.
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
        ...sourceRows(sources, label),
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
