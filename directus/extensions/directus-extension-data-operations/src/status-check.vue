<script setup lang="ts">
import type { CheckView } from './status-contract.js';

import StatusBadge from './status-badge.vue';
import { checkLinkText } from './status-labels.js';

// One readiness check: severity, code, count and the link to its records.
defineProps<{ check: CheckView }>();
</script>

<template>
  <tr :data-check="check.code" :class="{ zero: check.count === 0 }">
    <td class="severity"><StatusBadge :state="check.severity" :tone="check.count === 0 ? 'neutral' : null" /></td>
    <th scope="row" :title="check.description">{{ check.code }}</th>
    <td class="count">{{ check.count }}</td>
    <td class="link">
      <router-link :to="check.link">{{ checkLinkText(check) }}</router-link>
    </td>
  </tr>
</template>

<style scoped>
th, td { padding: 4px 8px 4px 0; text-align: start; vertical-align: baseline; border-block-end: 1px solid var(--theme--border-color-subdued, var(--theme--border-color)); }
th { font-weight: 500; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 12px; overflow-wrap: anywhere; }
.severity { width: 1%; }
.count { width: 1%; text-align: end; font-weight: 600; }
.link { width: 1%; white-space: nowrap; }
.link a { color: var(--theme--primary); text-decoration: underline; text-underline-offset: 3px; }
.zero { opacity: 0.65; }
</style>
