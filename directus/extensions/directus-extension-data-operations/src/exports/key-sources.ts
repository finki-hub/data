import type { KeySource, KeySourceName } from './types.js';

// The per-row opt-in every key source reads: a row places keys only while
// its own flag is set.
export const optInField = 'published';

const optedIn = { [optInField]: { _eq: true } };

// The closed vocabulary of key sources: sets of public keys that rows
// decide, each row opted in by its own `published` flag. A definition
// places a source's keys with a keyed or block entry (types.ts); nothing
// else adds a key at runtime. Readiness blocks a keyed row without its
// position and two siblings sharing one (key-order.ts), and the database
// keeps the key text of a published row (key-guards.ts), so a key never
// moves or changes silently.
//
// published_years: every academic year whose `published` flag is set,
// newest first (`sort` descending, then the label descending), keyed by its
// label. A new academic_years row adds no public key until its `published`
// flag is set. Readiness also blocks a published year until every course
// has its count.
//
// published_generations: every curriculum generation with a curriculum
// whose `published` flag is set, newest first (`sort` descending, then the
// code descending), keyed by its code. A new generation row adds no
// public key until its `published` flag is set.
//
// published_programs: every published study program of a published
// generation with a curriculum, keyed by its code and nested under its
// generation's block (`parent`), in `sort` order, then code. A new program
// row adds no public key until it and its generation are published.
export const keySources: Readonly<Record<KeySourceName, KeySource>> = {
  published_generations: {
    collection: 'curriculum_generations',
    fields: ['id', 'code', 'sort'],
    filter: {
      _and: [optedIn, { has_curriculum: { _eq: true } }],
    },
    key: 'code',
    position: { field: 'sort', row: 'curriculum_generation' },
    sort: ['-sort', '-code'],
    title: 'label',
  },
  published_programs: {
    collection: 'study_programs',
    fields: ['id', 'code', 'sort', 'generation'],
    filter: {
      _and: [
        optedIn,
        { generation: optedIn },
        { generation: { has_curriculum: { _eq: true } } },
      ],
    },
    key: 'code',
    parent: 'generation',
    position: { field: 'sort', row: 'study_program' },
    sort: ['generation', 'sort', 'code'],
    title: 'name',
  },
  published_years: {
    collection: 'academic_years',
    fields: ['id', 'label', 'sort'],
    filter: optedIn,
    key: 'label',
    position: { field: 'sort', row: 'academic_year' },
    sort: ['-sort', '-label'],
  },
};

// The filter of the rows whose related row, through the M2O `field`, is
// published: the rows a published year or generation keys.
export const publishedThrough = (field: string) => ({ [field]: optedIn });
