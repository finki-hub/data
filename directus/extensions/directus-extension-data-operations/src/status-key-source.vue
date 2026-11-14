<script setup lang="ts">
import type { KeySourceView } from './status-contract.js';

import { collectionText } from './status-labels.js';
import { useStudioName } from './studio-name.js';

// One key source: its collection, named as Studio names it, and every row
// with its key text, whether it is published and whether it places keys
// now, each linked to its Studio form.
const { source } = defineProps<{ source: KeySourceView }>();

const studioName = useStudioName(() => source.collection);

const stateOf = (row: KeySourceView['rows'][number]): string => {
  if (row.placesKeys) {
    return 'public';
  }
  return row.published ? 'published (no key)' : 'unpublished';
};
</script>

<template>
  <div
    class="source"
    :data-key-source="source.name"
  >
    <h5>
      <router-link :to="source.link">{{
        collectionText(source.collection, studioName)
      }}</router-link>
      <span class="note"
        >({{ source.rows.filter((row) => row.placesKeys).length }} of
        {{ source.rows.length }} public)</span
      >
    </h5>
    <p
      v-if="source.rows.length === 0"
      class="note"
    >
      No rows
    </p>
    <ul
      v-else
      class="chips"
    >
      <li
        v-for="row in source.rows"
        :key="String(row.id)"
        :class="{ placed: row.placesKeys, unpublished: !row.published }"
      >
        <router-link :to="row.link">{{ row.key ?? '--' }}</router-link>
        <small>{{ stateOf(row) }}</small>
      </li>
    </ul>
  </div>
</template>

<style scoped>
h5 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 600;
}
h5 a {
  color: var(--theme--primary);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.chips li {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 10px;
  border: 1px solid var(--theme--border-color);
  border-radius: 999px;
}
.chips li.placed {
  border-color: var(--theme--success);
}
.chips li.unpublished {
  border-style: dashed;
  color: var(--theme--foreground-subdued);
}
.chips a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
}
small,
.note {
  color: var(--theme--foreground-subdued);
  font-size: 12px;
}
</style>
