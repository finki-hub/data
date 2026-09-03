import { privateCollectionSpecs } from './specs/private.js';
import { publicCollectionSpecs } from './specs/public.js';
import { referenceCollectionSpecs } from './specs/reference.js';

export const collectionSpecs = [
  ...publicCollectionSpecs,
  ...referenceCollectionSpecs,
  ...privateCollectionSpecs,
] as const;
