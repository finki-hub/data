import { useCollection } from '@directus/extensions-sdk';
import { computed, type ComputedRef } from 'vue';

// The name Studio shows for a collection, from the app's collections
// store: its label in the interface language (en-US declares one), or none
// while the store does not list the collection. collectionText
// (status-labels.ts) falls back to the humanized key.
export const useStudioName = (
  collection: () => string,
): ComputedRef<string | undefined> => {
  const { info } = useCollection(computed(collection));
  return computed(() => info.value?.name);
};
