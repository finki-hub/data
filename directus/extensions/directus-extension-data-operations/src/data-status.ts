import { useApi } from '@directus/extensions-sdk';
import { computed, onScopeDispose, reactive, ref, type Ref, watch } from 'vue';

import {
  readinessPath,
  statusPath,
  type StatusSection,
} from './managed-flows.js';
import { readFailureText, refusalOf } from './panel-answers.js';
import { runSignal, runsInFlight } from './run-signal.js';
import {
  envelope,
  isBusy,
  isRefusal,
  nextReadMs,
  type ReadinessView,
  readinessViewSchema,
  type StatusView,
  statusViewSchema,
} from './status-contract.js';

// The state of one status panel: the data status and, when the panel shows
// it, readiness, both from the authorized status read. While work is in
// flight the status is polled, and a failed read that may pass later is
// repeated with a growing pause; readiness (which counts every check) is
// read again once the work settled, on a refresh and on the dashboard's
// own refresh.

const statusAnswer = envelope(statusViewSchema);
const readinessAnswer = envelope(readinessViewSchema);

export const useDataStatus = (
  sections: () => readonly StatusSection[],
  now: Ref<unknown>,
) => {
  const api = useApi();
  const status = ref<null | StatusView>(null);
  const readiness = ref<null | ReadinessView>(null);
  const statusError = ref<null | string>(null);
  const readinessError = ref<null | string>(null);
  const loading = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wasBusy = false;
  let failures = 0;
  let refused = false;

  const shows = (section: StatusSection): boolean =>
    sections().includes(section);

  const readReadiness = async (): Promise<void> => {
    if (!shows('readiness')) {
      return;
    }
    try {
      const answer = await api.get(readinessPath);
      readiness.value = readinessAnswer.parse(answer.data).data;
      readinessError.value = null;
    } catch (error) {
      readinessError.value = readFailureText(
        'Readiness checks',
        refusalOf(error),
      );
    }
  };

  const schedule = (again: () => Promise<void>): void => {
    clearTimeout(timer);
    const delay = nextReadMs({
      busy: isBusy(status.value) || runsInFlight.value > 0,
      failures,
      refused,
    });
    timer =
      delay === null
        ? undefined
        : setTimeout(() => {
            void again();
          }, delay);
  };

  // The status alone; readiness again once the work in flight settled.
  const poll = async (): Promise<void> => {
    try {
      const answer = await api.get(statusPath);
      status.value = statusAnswer.parse(answer.data).data;
      statusError.value = null;
      failures = 0;
      refused = false;
    } catch (error) {
      const refusal = refusalOf(error);
      statusError.value = readFailureText('Data status', refusal);
      failures += 1;
      refused = isRefusal(refusal.status);
    }
    const busy = isBusy(status.value);
    const settled = wasBusy && !busy;
    wasBusy = busy;
    schedule(poll);
    if (settled) {
      await readReadiness();
    }
  };

  const refresh = async (): Promise<void> => {
    loading.value = true;
    try {
      await Promise.all([poll(), readReadiness()]);
    } finally {
      loading.value = false;
    }
  };

  watch(
    [sections, now],
    () => {
      void refresh();
    },
    { immediate: true },
  );
  // A run started or ended in a Run operation panel of this page: read
  // the status and readiness again.
  watch(runSignal, () => {
    void refresh();
  });
  // The component's scope ends when the panel unmounts.
  onScopeDispose(() => {
    clearTimeout(timer);
  });

  return reactive({
    busy: computed(() => isBusy(status.value)),
    loading,
    readiness,
    readinessError,
    refresh,
    shows,
    status,
    statusError,
  });
};
