<script setup lang="ts">
import { computed, toRef } from 'vue';

import { flowKeyOf } from './panel-contract.js';
import { useRunOperation } from './run-operation.js';

const {
  flow = null,
  now = null,
  showHeader,
} = defineProps<{
  flow?: unknown;
  now?: unknown;
  showHeader?: boolean;
}>();

const flowKey = computed(() => flowKeyOf(flow));
const run = useRunOperation(
  () => flowKey.value,
  toRef(() => now),
);
</script>

<template>
  <div
    class="run-operation"
    :class="{ 'has-header': showHeader }"
    :data-flow="flowKey ?? ''"
  >
    <p
      v-if="flowKey === null"
      class="hint"
    >
      No Flow selected
    </p>
    <div
      v-else-if="run.loading"
      class="centered"
    >
      <v-progress-circular indeterminate />
    </div>
    <v-notice
      v-else-if="run.loadError"
      type="warning"
      >{{ run.loadError }}</v-notice
    >
    <template v-else-if="run.flow">
      <div class="actions">
        <v-button
          small
          :disabled="!run.canRun"
          :loading="run.running"
          class="run"
          @click="run.start"
        >
          <v-icon
            name="play_arrow"
            left
            small
          />Run
        </v-button>
        <v-button
          v-if="run.failure"
          small
          secondary
          :disabled="!run.canRun"
          class="retry"
          @click="run.retry"
        >
          <v-icon
            name="replay"
            left
            small
          />Retry
        </v-button>
        <router-link
          v-if="run.settingsLink"
          :to="run.settingsLink"
          class="settings"
          >Edit Flow</router-link
        >
      </div>
      <v-notice
        v-if="run.reason"
        key="v-notice-2"
        type="warning"
        >{{ run.reason }}</v-notice
      >
      <output
        v-else-if="run.statusProblem"
        class="state status-problem"
        ><v-icon
          name="error_outline"
          x-small
        />
        {{ run.statusProblem }}</output
      >
      <p
        v-else-if="run.waitingFor"
        class="state"
      >
        <v-icon
          name="hourglass_top"
          x-small
        />
        Waiting: {{ run.waitingFor }}
      </p>
      <output
        v-if="run.running"
        class="state"
        ><v-icon
          name="sync"
          x-small
        />
        Running</output
      >
      <div
        v-if="run.lines"
        class="outcome"
        aria-live="polite"
      >
        <p class="finished">
          <v-icon
            name="check_circle"
            x-small
          />
          Succeeded
        </p>
        <dl
          v-if="run.lines.length"
          class="answer"
        >
          <template
            v-for="line in run.lines"
            :key="line.label"
          >
            <dt>{{ line.label }}</dt>
            <dd>{{ line.text }}</dd>
          </template>
        </dl>
      </div>
      <v-notice
        v-if="run.failure"
        key="v-notice-3"
        type="danger"
        class="failure"
        aria-live="polite"
      >
        <div class="failure-text">
          <strong class="failure-code"
            >Failed:
            <template
              v-for="(part, index) in run.failure.code.split('_')"
              :key="index"
              ><template v-if="index > 0">_<wbr /></template
              >{{ part }}</template
            ></strong
          >
          <span
            v-if="run.failure.message"
            class="failure-message"
            :title="run.failure.message"
            >{{ run.failure.message }}</span
          >
        </div>
      </v-notice>
      <p class="flow-name">
        <v-icon
          :name="run.flow.icon ?? 'bolt'"
          x-small
        />
        {{ run.flow.name }}
      </p>
      <p
        v-if="run.flow.description"
        class="description"
        :title="run.flow.description"
      >
        {{ run.flow.description }}
      </p>
    </template>

    <v-dialog
      :model-value="run.dialogOpen"
      keep-behind
      @esc="run.cancel"
      @update:model-value="run.cancel"
    >
      <v-card class="confirm">
        <v-card-title>{{ run.description }}</v-card-title>
        <v-card-text>
          <v-form
            v-if="run.fields.length"
            :fields="run.fields"
            :model-value="run.values"
            primary-key="+"
            autofocus
            @update:model-value="run.setValues"
          />
        </v-card-text>
        <v-card-actions>
          <v-button
            secondary
            @click="run.cancel"
            >Cancel</v-button
          >
          <v-button
            :disabled="run.missing.length > 0"
            class="confirm-run"
            @click="run.confirm"
            >Run</v-button
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.run-operation {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 12px 16px 16px;
  overflow: auto;
  color: var(--theme--foreground);
}
.run-operation.has-header {
  padding-block-start: 0;
}
/* A small panel scrolls; its rows keep their height instead of shrinking. */
.run-operation > * {
  flex-shrink: 0;
}
.hint,
.description,
.state,
.flow-name {
  color: var(--theme--foreground-subdued);
  line-height: 1.45;
  font-size: 13px;
}
.state,
.finished {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.finished {
  color: var(--theme--success);
  font-weight: 600;
  font-size: 13px;
}
.flow-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.description {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
}
.centered {
  display: grid;
  place-items: center;
  height: 100%;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.settings {
  color: var(--theme--primary);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 3px;
  white-space: nowrap;
}
.failure-text {
  display: grid;
  gap: 2px;
  min-inline-size: 0;
}
.failure-code {
  overflow-wrap: anywhere;
}
.failure-message {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
  line-clamp: 5;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.outcome {
  display: grid;
  gap: 6px;
}
.answer {
  display: grid;
  grid-template-columns: fit-content(45%) minmax(0, 1fr);
  gap: 2px 12px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.answer dt,
.answer dd {
  display: block;
  min-inline-size: 0;
  margin: 0;
  overflow: visible;
  white-space: normal;
  text-overflow: clip;
  overflow-wrap: anywhere;
}
.answer dt {
  color: var(--theme--foreground-subdued);
  font-weight: 400;
}
.confirm {
  max-width: 640px;
}
</style>
