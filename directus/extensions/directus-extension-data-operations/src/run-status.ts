import { useApi } from '@directus/extensions-sdk';
import { computed, onScopeDispose, ref } from 'vue';

import { statusPath } from './managed-flows.js';
import { type Refusal, refusalOf } from './panel-answers.js';
import {
  envelope,
  isBusy,
  isRefusal,
  nextReadMs,
  type StatusView,
  statusViewSchema,
} from './status-contract.js';

// The data status as a Run operation panel follows it: read on demand,
// again every pollMs while a run of the page or the server's work is in
// flight, and after a failed read that may pass later with a growing
// pause. A failed read leaves no server state, so Run waits and the panel
// says why instead of naming a reason that does not hold.

const statusAnswer = envelope(statusViewSchema);

// Why Run waits when the status read failed, or null when it did not.
export const statusProblemText = (refusal: null | Refusal): null | string => {
  if (refusal === null) {
    return null;
  }
  return isRefusal(refusal.status)
    ? 'You may not read the data status; data operations are for administrators.'
    : `The data status could not be read (${refusal.code}); Run waits for it and reads it again shortly.`;
};

export const useRunStatus = (runInFlight: () => boolean) => {
  const api = useApi();
  const status = ref<null | StatusView>(null);
  const refusal = ref<null | Refusal>(null);
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The next read, if any is due.
  const schedule = (again: () => Promise<void>): void => {
    clearTimeout(timer);
    const delay = nextReadMs({
      busy: runInFlight() || isBusy(status.value),
      failures,
      refused: isRefusal(refusal.value?.status ?? null),
    });
    timer =
      delay === null
        ? undefined
        : setTimeout(() => {
            void again();
          }, delay);
  };

  const refresh = async (): Promise<void> => {
    try {
      const answer = await api.get(statusPath);
      status.value = statusAnswer.parse(answer.data).data;
      refusal.value = null;
      failures = 0;
    } catch (error) {
      status.value = null;
      refusal.value = refusalOf(error);
      failures += 1;
    }
    schedule(refresh);
  };

  // The component's scope ends when the panel unmounts.
  onScopeDispose(() => {
    clearTimeout(timer);
  });

  return {
    problem: computed(() => statusProblemText(refusal.value)),
    refresh,
    schedule: () => {
      schedule(refresh);
    },
    status,
  };
};
