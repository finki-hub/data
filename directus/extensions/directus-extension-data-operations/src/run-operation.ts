import { useApi } from '@directus/extensions-sdk';
import { computed, reactive, ref, type Ref, watch } from 'vue';

import { flowSettingsPage } from './managed-flows.js';
import {
  answerSummary,
  type Refusal,
  refusalOf,
  type SummaryLine,
} from './panel-answers.js';
import {
  type DialogValues,
  flowFields,
  type ManualFlow,
  manualFlowSchema,
  missingRequired,
  retryValues,
  runPlan,
  triggerBody,
} from './panel-contract.js';
import { endRun, runSignal, runsInFlight, startRun } from './run-signal.js';
import { useRunStatus } from './run-status.js';
import { envelope } from './status-contract.js';
import { waitingText } from './status-labels.js';

// The state of one Run operation panel: the chosen Flow and whether it
// can run from here, the server's claim (which disables Run while any data
// operation holds it), the dialog of the Flow's own fields, and the answer
// or refusal of the last run with a retry of its inputs. Run posts to the
// native POST /flows/trigger/:id with the session of the Studio user; the
// Flow and the endpoint decide, the panel only follows. Every Run opens
// the dialog empty; only a Retry of a failed run offers its inputs again,
// less the boolean acknowledgements (retryValues).

type RunOutcome =
  | (Refusal & { readonly ok: false })
  | { readonly lines: readonly SummaryLine[]; readonly ok: true };

const flowAnswer = envelope(manualFlowSchema);

const loadMessage = (error: unknown): string => {
  const refusal = refusalOf(error);
  return refusal.status === 403
    ? 'You may not read this Flow.'
    : `The Flow could not be read (${refusal.code}).`;
};

export const useRunOperation = (
  flowKey: () => null | string,
  now: Ref<unknown>,
) => {
  const api = useApi();
  const flow = ref<ManualFlow | null>(null);
  const loading = ref(false);
  const loadError = ref<null | string>(null);
  const dialogOpen = ref(false);
  const values = ref<DialogValues>({});
  // The inputs of the last run while it stands failed, else null.
  const failedInput = ref<DialogValues | null>(null);
  const running = ref(false);
  const outcome = ref<null | RunOutcome>(null);
  const {
    problem: statusProblem,
    refresh: refreshStatus,
    schedule,
    status,
  } = useRunStatus(() => running.value || runsInFlight.value > 0);

  const plan = computed(() =>
    flow.value === null ? null : runPlan(flow.value),
  );
  const runnable = computed(() =>
    plan.value?.runnable === true ? plan.value : null,
  );
  const isAdmin = computed(() => status.value?.audience === 'administrator');
  // Another panel of this page has a run in flight: it takes the claim,
  // so Run waits for it without waiting for the next status read.
  const otherRun = computed(() => runsInFlight.value > (running.value ? 1 : 0));
  const waitingFor = computed(() =>
    waitingText(status.value?.claim ?? null, otherRun.value),
  );
  const canRun = computed(
    () =>
      runnable.value !== null &&
      isAdmin.value &&
      !running.value &&
      !otherRun.value &&
      status.value?.claim === null,
  );
  const fields = computed(() => runnable.value?.fields ?? []);
  const missing = computed(() => missingRequired(fields.value, values.value));

  const load = async (): Promise<void> => {
    const key = flowKey();
    flow.value = null;
    loadError.value = null;
    if (key === null) {
      return;
    }
    // The panel shows the Flow once the status says who may run it.
    loading.value = true;
    try {
      const answer = await api.get(`/flows/${encodeURIComponent(key)}`, {
        params: { fields: flowFields.join(',') },
      });
      flow.value = flowAnswer.parse(answer.data).data;
    } catch (error) {
      loadError.value = loadMessage(error);
    }
    await refreshStatus();
    loading.value = false;
  };

  const run = async (input: DialogValues): Promise<void> => {
    const target = runnable.value;
    const id = flow.value?.id;
    if (target === null || id === undefined || !canRun.value) {
      return;
    }
    running.value = true;
    dialogOpen.value = false;
    outcome.value = null;
    startRun();
    schedule();
    try {
      const answer = await api.post(
        `/flows/trigger/${encodeURIComponent(id)}`,
        triggerBody(target, input),
      );
      // A runnable Flow is synchronous and reports its failures, so a
      // 2xx answer is a finished run (204: its last step answered nothing).
      outcome.value = {
        lines: answerSummary(answer.status === 204 ? null : answer.data),
        ok: true,
      };
      failedInput.value = null;
    } catch (error) {
      outcome.value = { ...refusalOf(error), ok: false };
      failedInput.value = { ...input };
    } finally {
      running.value = false;
      endRun();
      await refreshStatus();
    }
  };

  // Opens the Flow's own confirmation with the given values, or runs a
  // Flow that asks for none.
  const open = (initial: DialogValues): void => {
    if (!canRun.value) {
      return;
    }
    if (runnable.value?.confirm === true) {
      values.value = initial;
      dialogOpen.value = true;
      return;
    }
    void run({});
  };

  // A new run: the dialog opens empty.
  const start = (): void => {
    open({});
  };

  // A retry of the failed run: the same Flow through the same
  // confirmation, with that run's inputs less its acknowledgements.
  const retry = (): void => {
    const failed = failedInput.value;
    if (failed !== null) {
      open(retryValues(fields.value, failed));
    }
  };

  const confirm = (): void => {
    if (missing.value.length === 0) {
      void run(values.value);
    }
  };

  const cancel = (): void => {
    dialogOpen.value = false;
  };

  const setValues = (next: unknown): void => {
    values.value = next !== null && typeof next === 'object' ? { ...next } : {};
  };

  watch(
    flowKey,
    () => {
      void load();
    },
    { immediate: true },
  );
  // The dashboard's own refresh, and a run of any panel of the page, read
  // the status again.
  watch([now, runSignal], () => {
    void refreshStatus();
  });

  return reactive({
    cancel,
    canRun,
    confirm,
    description: computed(() => runnable.value?.description ?? ''),
    dialogOpen,
    // The refusal of the last run, or null.
    failure: computed(() =>
      outcome.value !== null && !outcome.value.ok ? outcome.value : null,
    ),
    fields,
    flow,
    isAdmin,
    // What the last successful run answered, or null.
    lines: computed(() =>
      outcome.value?.ok === true ? outcome.value.lines : null,
    ),
    loadError,
    loading,
    missing,
    reason: computed(() =>
      plan.value?.runnable === false ? plan.value.reason : null,
    ),
    retry,
    running,
    settingsLink: computed(() =>
      flow.value === null ? null : flowSettingsPage(flow.value.id),
    ),
    setValues,
    start,
    // Why Run waits for the status read, or null.
    statusProblem,
    values,
    waitingFor,
  });
};

export type RunOperation = ReturnType<typeof useRunOperation>;
