<script setup lang="ts">
import type { KeySourceView } from './status-contract.js';

import StatusKeySource from './status-key-source.vue';

// The rows whose flags decide the public keys, per key source.
const { sources } = defineProps<{ sources: readonly KeySourceView[] }>();
</script>

<template>
  <section
    class="block"
    aria-label="Published keys"
  >
    <StatusKeySource
      v-for="source in sources"
      :key="source.name"
      :source="source"
    />
  </section>
</template>

<style scoped>
.block {
  display: grid;
  gap: 10px;
}
</style>
