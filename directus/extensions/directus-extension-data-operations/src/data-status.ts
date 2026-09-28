import { useApi } from '@directus/extensions-sdk';
import { computed, onScopeDispose, reactive, ref, type Ref, watch } from 'vue';

import {
  readinessPath,
  statusPath,
  type StatusSection,
} from './managed-flows.js';
import { readableCollections, refusalOf } from './panel-answers.js';
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
// own refresh. For an editor the Studio links are shown only for the
// collections GET /permissions/me says they may read; the pages enforce
// the same permissions themselves.

const statusAnswer = envelope(statusViewSchema);
const readinessAnswer = envelope(readinessViewSchema);

const failureText = (what: string, error: unknown): string => {
  const refusal = refusalOf(error);
  if (refusal.status === 401 || refusal.status === 403) {
    return `You may not read the ${what}: ${refusal.message}`;
  }
  return `The ${what} could not be read (${refusal.code}): ${refusal.message}`;
};

export const useDataStatus = (
  sections: () => readonly StatusSection[],
  now: Ref<unknown>,
) => {
  const api = useApi();
  const status = ref<null | StatusView>(null);
  const readiness = ref<null | ReadinessView>(null);
  const readable = ref<null | ReadonlySet<string>>(null);
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
      readinessError.value = failureText('readiness checks', error);
    }
  };

  // The collections an editor may read; administrators read all.
  const readableOf = async (): Promise<null | ReadonlySet<string>> => {
    if (status.value?.audience !== 'editor') {
      return null;
    }
    try {
      const answer = await api.get('/permissions/me');
      return readableCollections(answer.data);
    } catch {
      return new Set();
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
      statusError.value = failureText('data status', error);
      failures += 1;
      refused = isRefusal(refusalOf(error).status);
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
      readable.value = await readableOf();
    } finally {
      loading.value = false;
    }
  };

  // Administrators follow every link; an editor the collections they read.
  const linkable = (collection: string): boolean =>
    status.value?.audience === 'administrator' ||
    (readable.value?.has(collection) ?? false);

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
    linkable,
    loading,
    readiness,
    readinessError,
    refresh,
    shows,
    status,
    statusError,
  });
};
