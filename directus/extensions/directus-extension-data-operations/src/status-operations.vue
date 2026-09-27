<script setup lang="ts">
import type { StatusView } from './status-contract.js';

import StatusBadge from './status-badge.vue';
import { bytesText, instantText, retriedText } from './status-labels.js';

// The calculation domains, the running claim, the last failure, every
// declared file with its last outcome, and the Moodle snapshot.
defineProps<{ status: StatusView }>();
</script>

<template>
  <section class="block" aria-label="Calculations">
    <h4>Calculations</h4>
    <table class="rows">
      <tbody>
        <tr v-for="domain in status.domains" :key="domain.name" :data-domain="domain.name">
          <th scope="row">{{ domain.label }}</th>
          <td><StatusBadge :state="domain.state" /></td>
          <td class="note">{{ domain.waitingFor.length > 0 ? `waits for ${domain.waitingFor.join(', ')}` : '' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="status.claim" class="note">
      Running: {{ status.claim.label }} since {{ instantText(status.claim.startedAt) }}{{ status.claim.stale ? ' (stale: released as abandoned by the next claim)' : '' }}
    </p>
    <p class="note">Last run {{ instantText(status.lastRun.startedAt) }} to {{ instantText(status.lastRun.finishedAt) }}{{ retriedText(status.lastRun.retries) }}</p>
  </section>

  <section class="block" aria-label="Published files">
    <h4>Published files <StatusBadge :state="status.publication.state" /></h4>
    <table class="rows">
      <thead>
        <tr><th scope="col">File</th><th scope="col">Outcome</th><th scope="col">Code</th><th scope="col" class="number">Revision</th><th scope="col" class="number">Size</th></tr>
      </thead>
      <tbody>
        <tr v-for="file in status.publication.files" :key="file.filename" :data-file="file.filename">
          <th scope="row">{{ file.filename }}</th>
          <td><StatusBadge :state="file.outcome" /></td>
          <td class="note code">{{ file.code ?? '' }}</td>
          <td class="note number">{{ file.revision ?? '--' }}</td>
          <td class="note number">{{ bytesText(file.bytes) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="note">
      Last publication: revision {{ status.publication.lastRevision ?? '--' }}{{ status.publication.complete ? ', every declared file uploaded' : status.publication.lastRevision === null ? '' : ', not every declared file uploaded' }}
    </p>
  </section>

  <section class="block" aria-label="Moodle snapshot">
    <h4>Moodle snapshot <StatusBadge :state="status.importState" /></h4>
    <p class="note">
      {{ status.historyIndex.users }} users, {{ status.historyIndex.indexedUsers }} indexed;
      {{ status.historyIndex.entries }} history entries, {{ status.historyIndex.needsMapping }} still need a mapping;
      {{ status.historyIndex.countMismatches }} users whose indexed entries differ from their Courses Count.
    </p>
  </section>

  <section v-if="status.lastError && status.lastError.blocking" class="block" aria-label="Last failure">
    <v-notice type="danger" class="failure">
      <span>
        <strong>{{ status.lastError.code }}</strong> in {{ status.lastError.domain ?? 'unknown' }} at revision {{ status.lastError.revision ?? '--' }},
        {{ instantText(status.lastError.at) }}{{ retriedText(status.lastError.retries) }}. Retry: run the operation again, or mark the domain pending (Data / Mark pending).
      </span>
    </v-notice>
    <details v-if="status.lastError.message" class="message">
      <summary>What the failing step said</summary>
      <p>{{ status.lastError.message }}</p>
    </details>
  </section>
</template>

<style scoped>
.block { display: grid; gap: 8px; }
h4 { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--theme--foreground-accent); }
.rows { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.rows th, .rows td { padding: 4px 8px 4px 0; text-align: start; border-block-end: 1px solid var(--theme--border-color-subdued, var(--theme--border-color)); }
.rows th { font-weight: 500; }
.rows thead th { font-size: 12px; color: var(--theme--foreground-subdued); }
.number { text-align: end; white-space: nowrap; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 12px; overflow-wrap: anywhere; }
.note { color: var(--theme--foreground-subdued); line-height: 1.45; }
.message summary { cursor: pointer; color: var(--theme--foreground-subdued); }
.message summary:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 2px; }
.message p { margin-block-start: 6px; overflow-wrap: anywhere; color: var(--theme--foreground-subdued); }
</style>
