<script setup lang="ts">
import type { StatusView } from './status-contract.js';

import StatusBadge from './status-badge.vue';
import {
  claimText,
  lastErrorText,
  lastRunText,
  snapshotText,
  waitsForText,
} from './status-facts.js';

// The calculation domains, the running claim, the last failure and the
// Moodle snapshot.
const { status } = defineProps<{ status: StatusView }>();
</script>

<template>
  <section
    class="block"
    aria-label="Calculations"
  >
    <h4>Calculations</h4>
    <table class="rows">
      <tbody>
        <tr
          v-for="domain in status.domains"
          :key="domain.name"
          :data-domain="domain.name"
        >
          <th scope="row">{{ domain.label }}</th>
          <td><StatusBadge :state="domain.state" /></td>
          <td class="note">{{ waitsForText(domain.waitingFor) }}</td>
        </tr>
      </tbody>
    </table>
    <p
      v-if="status.claim"
      class="note"
    >
      {{ claimText(status.claim) }}
    </p>
    <p class="note">{{ lastRunText(status.lastRun) }}</p>
  </section>

  <section
    class="block"
    aria-label="Moodle snapshot"
  >
    <h4>Moodle snapshot <StatusBadge :state="status.importState" /></h4>
    <p class="note">{{ snapshotText(status.historyIndex) }}</p>
  </section>

  <section
    v-if="status.lastError && status.lastError.blocking"
    class="block"
    aria-label="Last failure"
  >
    <v-notice
      type="danger"
      class="failure"
    >
      <span
        ><strong>{{ status.lastError.code }}</strong> ·
        {{ lastErrorText(status.lastError) }}</span
      >
    </v-notice>
    <details
      v-if="status.lastError.message"
      class="message"
    >
      <summary>Message</summary>
      <p>{{ status.lastError.message }}</p>
    </details>
  </section>
</template>

<style scoped>
.block {
  display: grid;
  gap: 8px;
}
h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--theme--foreground-accent);
}
.rows {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.rows th,
.rows td {
  padding: 4px 8px 4px 0;
  text-align: start;
  border-block-end: 1px solid
    var(--theme--border-color-subdued, var(--theme--border-color));
}
.rows th {
  font-weight: 500;
}
.rows thead th {
  font-size: 12px;
  color: var(--theme--foreground-subdued);
}
.number {
  text-align: end;
  white-space: nowrap;
}
.code {
  font-family: var(--theme--fonts--monospace--font-family, monospace);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.note {
  color: var(--theme--foreground-subdued);
  line-height: 1.45;
}
.message summary {
  cursor: pointer;
  color: var(--theme--foreground-subdued);
}
.message summary:focus-visible {
  outline: 2px solid var(--theme--primary);
  outline-offset: 2px;
}
.message p {
  margin-block-start: 6px;
  overflow-wrap: anywhere;
  color: var(--theme--foreground-subdued);
}
</style>
