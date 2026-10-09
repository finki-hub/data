import type { ModelCollection, ModelCollectionKey } from '../schema.js';

import { contentCollections } from './content-collections.js';
import { curriculumCollections } from './curriculum-collections.js';
import { generationCollections } from './generation-collections.js';
import { mappingCollections } from './mapping-collections.js';
import { moodleCollections } from './moodle-collections.js';
import { operationsCollections } from './operations-collections.js';

// Every collection of the relational model in installation order: the
// content the workbook import fills first, then the collections that link
// it, the Moodle collections with their pattern mappings and the
// operations bookkeeping.
export const dataModelCollections: readonly ModelCollection[] = [
  ...contentCollections,
  ...curriculumCollections,
  ...generationCollections,
  ...moodleCollections,
  ...mappingCollections,
  ...operationsCollections,
];

export const dataModelCollectionKeys: readonly ModelCollectionKey[] =
  dataModelCollections.map(({ collection }) => collection);

export const findModelCollection = (
  collection: string,
): ModelCollection | undefined =>
  dataModelCollections.find((candidate) => candidate.collection === collection);
