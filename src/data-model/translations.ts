import type { CollectionLabel } from '../schema.js';

// Labels are English translations: Studio shows them for an English
// interface language.
const labelLanguage = 'en-US';

export type FieldTranslation = {
  readonly language: string;
  readonly translation: string;
};

type CollectionTranslation = FieldTranslation & {
  readonly plural: string;
  readonly singular: string;
};

// The `meta.translations` of a labelled field or alias.
export const fieldTranslations = (
  label: string,
): readonly FieldTranslation[] => [
  { language: labelLanguage, translation: label },
];

// The `meta.translations` of a labelled collection: its name is the plural.
export const collectionTranslations = (
  label: CollectionLabel,
): readonly CollectionTranslation[] => [
  {
    language: labelLanguage,
    plural: label.plural,
    singular: label.singular,
    translation: label.plural,
  },
];
