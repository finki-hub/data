import type { ModelCollection, ModelCollectionKey } from '../schema.js';

import { checkpointCollections } from './checkpoint-collections.js';
import { curriculumCollections } from './curriculum-collections.js';
import { migrationCollections } from './migration-collections.js';
import { moodleCollections } from './moodle-collections.js';
import { operationsCollections } from './operations-collections.js';

// Every collection of the relational model in installation order: the
// adopted checkpoint collections first, then the new relational ones.
export const dataModelCollections: readonly ModelCollection[] = [
  ...checkpointCollections,
  ...curriculumCollections,
  ...moodleCollections,
  ...operationsCollections,
  ...migrationCollections,
];

export const dataModelCollectionKeys: readonly ModelCollectionKey[] =
  dataModelCollections.map(({ collection }) => collection);

export const findModelCollection = (
  collection: string,
): ModelCollection | undefined =>
  dataModelCollections.find((candidate) => candidate.collection === collection);
