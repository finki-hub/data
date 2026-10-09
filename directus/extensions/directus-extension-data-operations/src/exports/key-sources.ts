import type { KeySource, KeySourceName } from './types.js';

// The per-row opt-in every key source reads: a row places keys only while
// its own flag is set.
export const optInField = 'published';

const optedIn = { [optInField]: { _eq: true } };

// The closed vocabulary of key sources: sets of public keys that rows
// decide, each row opted in by its own `published` flag. A definition
// places a source's keys with a keyed or block entry (types.ts); nothing
// else adds a key at runtime. Keys are ordered by their own key text,
// which is unique, so the order is total; consumers read keys by name. The
// database keeps the key text of a published row (key-guards.ts), so a key
// never changes silently.
//
// published_years: every academic year whose `published` flag is set,
// keyed by its label, label descending (newest first for YYYY/YYYY
// labels). A new academic_years row adds no public key until its
// `published` flag is set. Readiness also blocks a published year until
// every course has its count.
//
// published_generations: every curriculum generation with a curriculum
// whose `published` flag is set, keyed by its code, code descending. A new
// generation row adds no public key until its `published` flag is set.
//
// published_programs: every published study program of a published
// generation with a curriculum, keyed by its code and nested under its
// generation's block (`parent`), in code order. A new program row adds no
// public key until it and its generation are published.
export const keySources: Readonly<Record<KeySourceName, KeySource>> = {
  published_generations: {
    collection: 'curriculum_generations',
    fields: ['id', 'code'],
    filter: {
      _and: [optedIn, { has_curriculum: { _eq: true } }],
    },
    key: 'code',
    sort: ['-code'],
  },
  published_programs: {
    collection: 'study_programs',
    fields: ['id', 'code', 'generation'],
    filter: {
      _and: [
        optedIn,
        { generation: optedIn },
        { generation: { has_curriculum: { _eq: true } } },
      ],
    },
    key: 'code',
    parent: 'generation',
    sort: ['generation', 'code'],
  },
  published_years: {
    collection: 'academic_years',
    fields: ['id', 'label'],
    filter: optedIn,
    key: 'label',
    sort: ['-label'],
  },
};

// The filter of the rows whose related row, through the M2O `field`, is
// published: the rows a published year or generation keys.
export const publishedThrough = (field: string) => ({ [field]: optedIn });
