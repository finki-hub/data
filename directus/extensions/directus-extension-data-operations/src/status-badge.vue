<script setup lang="ts">
import { computed } from 'vue';

import { stateLabel, type Tone, toneOf } from './status-labels.js';

// One state, outcome or severity as a small coloured label.
const props = withDefaults(
  defineProps<{ label?: null | string; state: null | string; tone?: null | Tone }>(),
  { label: null, tone: null },
);

const shown = computed(() => props.label ?? stateLabel(props.state));
const colour = computed(() => props.tone ?? toneOf(props.state));
</script>

<template>
  <span class="badge" :class="`tone-${colour}`">{{ shown }}</span>
</template>

<style scoped>
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.6; white-space: nowrap; color: var(--theme--foreground-subdued); background: var(--theme--background-subdued); }
.tone-success { color: var(--theme--success); background: var(--theme--success-background, var(--theme--background-subdued)); }
.tone-warning { color: var(--theme--warning); background: var(--theme--warning-background, var(--theme--background-subdued)); }
.tone-danger { color: var(--theme--danger); background: var(--theme--danger-background, var(--theme--background-subdued)); }
.tone-info { color: var(--theme--primary); background: var(--theme--primary-background, var(--theme--background-subdued)); }
</style>
