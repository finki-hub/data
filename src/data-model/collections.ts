import type { ModelCollection, ModelCollectionKey } from '../schema.js';

import {
  botContentCollections,
  contentCollections,
} from './content-collections.js';
import { curriculumCollections } from './curriculum-collections.js';
import { generationCollections } from './generation-collections.js';
import { mappingCollections } from './mapping-collections.js';
import { moodleCollections } from './moodle-collections.js';
import { operationsCollections } from './operations-collections.js';
import { referenceCollections } from './reference-collections.js';
import { teachingCollections } from './teaching-collections.js';
import { thesisCollections } from './thesis-collections.js';

// Every collection of the relational model in installation order: the
// content and reference lists the workbook import fills first, the bot
// content, then the collections that link them, the Moodle collections
// with their pattern mappings, the operations bookkeeping, the timetable
// teaching data and the theses.
export const dataModelCollections: readonly ModelCollection[] = [
  ...contentCollections,
  ...referenceCollections,
  ...botContentCollections,
  ...curriculumCollections,
  ...generationCollections,
  ...moodleCollections,
  ...mappingCollections,
  ...operationsCollections,
  ...teachingCollections,
  ...thesisCollections,
];

export const dataModelCollectionKeys: readonly ModelCollectionKey[] =
  dataModelCollections.map(({ collection }) => collection);

export const findModelCollection = (
  collection: string,
): ModelCollection | undefined =>
  dataModelCollections.find((candidate) => candidate.collection === collection);
