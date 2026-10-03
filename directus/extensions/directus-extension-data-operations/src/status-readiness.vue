<script setup lang="ts">
import { computed } from 'vue';

import type { ReadinessView } from './status-contract.js';

import CheckRow from './status-check.vue';
import StatusBadge from './status-badge.vue';
import { readinessText } from './status-facts.js';
import { orderedChecks } from './status-labels.js';
import { countText } from './text.js';

// Every declared readiness check with its count and one link to the
// records behind it; checks with a count first.
const props = defineProps<{
  error: null | string;
  readiness: null | ReadinessView;
}>();

const checks = computed(() =>
  props.readiness === null ? [] : orderedChecks(props.readiness.checks),
);
const open = computed(() => checks.value.filter(({ count }) => count > 0));
const clear = computed(() => checks.value.filter(({ count }) => count === 0));
</script>

<template>
  <section class="block" aria-label="Readiness checks">
    <v-notice v-if="error" type="warning">{{ error }}</v-notice>
    <p v-else-if="readiness === null" class="note">Loading readiness checks…</p>
    <template v-else>
      <p class="summary">
        <StatusBadge :state="readiness.ready ? 'ready' : 'blocked'" :label="readiness.ready ? 'Ready' : 'Blocked'" :tone="readiness.ready ? 'success' : 'danger'" />
        <span class="note">· {{ readinessText(readiness) }}</span>
      </p>
      <p v-if="open.length === 0" class="note">No open checks</p>
      <table v-else class="rows">
        <tbody>
          <CheckRow v-for="check in open" :key="check.code" :check="check" />
        </tbody>
      </table>
      <details v-if="clear.length > 0" class="clear">
        <summary>Zero count: {{ countText(clear.length, 'check', 'checks') }}</summary>
        <table class="rows">
          <tbody>
            <CheckRow v-for="check in clear" :key="check.code" :check="check" />
          </tbody>
        </table>
      </details>
    </template>
  </section>
</template>

<style scoped>
.block { display: grid; gap: 8px; }
.summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.rows { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.clear summary { cursor: pointer; color: var(--theme--foreground-subdued); padding-block: 4px; }
.clear summary:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 2px; }
.note { color: var(--theme--foreground-subdued); line-height: 1.45; }
</style>
