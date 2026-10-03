<script setup lang="ts">
import { computed, toRef } from 'vue';

import { useDataStatus } from './data-status.js';
import { sectionsOf } from './managed-flows.js';
import { toolbarText } from './status-facts.js';
import StatusKeys from './status-keys.vue';
import StatusOperations from './status-operations.vue';
import StatusReadiness from './status-readiness.vue';

const props = defineProps<{ now?: unknown; sections?: unknown; showHeader?: boolean }>();

const sections = computed(() => sectionsOf(props.sections));
const data = useDataStatus(() => sections.value, toRef(props, 'now'));
</script>

<template>
  <div class="data-status" :class="{ 'has-header': showHeader }" :aria-busy="data.loading">
    <div class="toolbar">
      <span v-if="data.status && data.shows('operations')" class="facts">{{ toolbarText(data.status) }}</span>
      <v-button x-small secondary icon :loading="data.loading" class="refresh" aria-label="Refresh the data status" @click="data.refresh">
        <v-icon name="refresh" x-small />
      </v-button>
    </div>
    <v-notice v-if="data.statusError" type="danger">{{ data.statusError }}</v-notice>
    <StatusOperations v-if="data.status && data.shows('operations')" :status="data.status" />
    <StatusReadiness v-if="data.shows('readiness')" :readiness="data.readiness" :error="data.readinessError" />
    <StatusKeys v-if="data.status && data.shows('keys')" :sources="data.status.keySources" />
  </div>
</template>

<style scoped>
.data-status { display: flex; flex-direction: column; gap: 16px; height: 100%; padding: 12px 16px 16px; overflow: auto; color: var(--theme--foreground); font-size: 13px; }
.data-status.has-header { padding-block-start: 0; }
.toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.refresh { margin-inline-start: auto; }
.facts { color: var(--theme--foreground-subdued); font-variant-numeric: tabular-nums; line-height: 1.5; }
</style>
