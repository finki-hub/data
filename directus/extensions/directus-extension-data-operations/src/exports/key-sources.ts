import type { KeySource, KeySourceName } from './types.js';

// The closed vocabulary of key sources: sets of public keys that rows
// decide, each row opted in by an editor. A definition places a source's
// keys with a keyed entry (types.ts); nothing else adds a key at runtime.
//
// published_years: every academic year whose `published` flag is set,
// newest first (`sort` descending, then the label descending), keyed by its
// label. A new academic_years row adds no public key until an editor
// publishes it. Readiness blocks a published year until every course has
// its count, and blocks two published years that share a sort.
export const keySources: Readonly<Record<KeySourceName, KeySource>> = {
  published_years: {
    collection: 'academic_years',
    fields: ['id', 'label', 'sort'],
    filter: { published: { _eq: true } },
    key: 'label',
    sort: ['-sort', '-label'],
  },
};

// The filter of the rows a published year keys: its relation to
// academic_years is `field`.
export const publishedYear = (field: string) => ({
  [field]: { published: { _eq: true } },
});
