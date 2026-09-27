import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type EffectScope, effectScope, ref } from 'vue';

import type { ManualFlow } from '../directus/extensions/directus-extension-data-operations/src/panel-contract.js';

import { statusPath } from '../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import {
  type RunOperation,
  useRunOperation,
} from '../directus/extensions/directus-extension-data-operations/src/run-operation.js';
import {
  pollMs,
  type StatusView,
} from '../directus/extensions/directus-extension-data-operations/src/status-contract.js';

// Task 16: the Run operation panel's state as Studio drives it, with the
// Studio API replaced by a synthetic one. Every Run opens the Flow's
// dialog empty; only a Retry of a failed run offers its inputs again, less
// the boolean acknowledgements; a failed status read says why Run waits
// and is read again, a refusal is not.

const api = vi.hoisted(() => ({
  get: vi.fn<(path: string) => Promise<unknown>>(),
  post: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));

vi.mock('@directus/extensions-sdk', () => ({ useApi: () => api }));

const flow: ManualFlow = {
  description: 'Synthetic import.',
  icon: 'upload',
  id: '9e4d826c-0000-4000-8000-000000001610',
  name: 'Data / Synthetic import',
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: 'Replace the synthetic snapshot?',
    error_on_reject: true,
    fields: [
      {
        field: 'file',
        meta: { interface: 'collection-item-dropdown', required: true },
        name: 'File',
        type: 'json',
      },
      {
        field: 'confirm_replace',
        meta: { interface: 'boolean' },
        name: 'Replace',
        type: 'boolean',
      },
      {
        field: 'allow_empty',
        meta: { interface: 'boolean' },
        name: 'Allow empty',
        type: 'boolean',
      },
    ],
    requireConfirmation: true,
    requireSelection: false,
  },
  status: 'active',
  trigger: 'manual',
};

const idle: StatusView = {
  audience: 'administrator',
  claim: null,
  domains: [],
  historyIndex: {
    countMismatches: 0,
    entries: 0,
    indexedUsers: 0,
    memberships: 0,
    needsMapping: 0,
    users: 0,
  },
  importState: 'completed',
  keySources: [],
  lastError: null,
  lastRun: { finishedAt: null, retries: 0, startedAt: null },
  publication: {
    complete: false,
    files: [],
    lastRevision: null,
    state: 'idle',
  },
  revisions: { completed: 1, requested: 1, source: 1 },
  schedule: [],
};

// A refusal as the Studio API throws it: an error with Directus's answer.
const refusal = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), {
    response: {
      data: { errors: [{ extensions: { code }, message }] },
      status,
    },
  });

const pick = { collection: 'directus_files', key: 'synthetic-file' };

// The next answers of the status read, then the idle status.
const statusAnswers: Array<() => Promise<unknown>> = [];

const answerGet = async (path: string): Promise<unknown> => {
  if (path === statusPath) {
    const next = statusAnswers.shift();
    return next === undefined ? { data: { data: idle } } : next();
  }
  return { data: { data: flow } };
};

const statusReads = () =>
  api.get.mock.calls.filter(([path]) => path === statusPath).length;

// The scope of each mounted panel state, stopped after each test as an
// unmount would.
const scopes: EffectScope[] = [];

const mount = async (): Promise<RunOperation> => {
  const scope = effectScope();
  scopes.push(scope);
  const run = scope.run(() => useRunOperation(() => flow.id, ref(0)));
  if (run === undefined) {
    throw new Error('the composable did not start');
  }
  await vi.waitFor(() => {
    expect(run.loading).toBe(false);
    expect(run.flow).not.toBeNull();
  });
  return run;
};

// Runs through the dialog with the given values and waits for the answer.
const runWith = async (
  run: RunOperation,
  values: Record<string, unknown>,
): Promise<void> => {
  run.setValues(values);
  run.confirm();
  await vi.waitFor(() => {
    expect(run.running).toBe(false);
    expect(run.lines ?? run.failure).not.toBeNull();
  });
};

beforeEach(() => {
  statusAnswers.length = 0;
  api.get.mockImplementation(answerGet);
  api.post.mockResolvedValue({ data: { rows: 40 }, status: 200 });
});

afterEach(() => {
  for (const scope of scopes) {
    scope.stop();
  }
  scopes.length = 0;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the Run operation dialog', () => {
  test('opens empty on every Run, also after a successful run', async () => {
    const run = await mount();

    run.start();

    expect(run.dialogOpen).toBeTruthy();
    expect(run.values).toEqual({});

    await runWith(run, {
      allow_empty: true,
      confirm_replace: true,
      file: pick,
    });

    expect(run.lines).toEqual([{ label: 'Rows', text: '40' }]);
    expect(api.post).toHaveBeenCalledWith(`/flows/trigger/${flow.id}`, {
      allow_empty: true,
      collection: 'data_operations',
      confirm_replace: true,
      file: pick,
    });

    run.start();

    expect(run.dialogOpen).toBeTruthy();
    expect(run.values).toEqual({});
  });

  test('offers the failed inputs on Retry only, less the acknowledgements', async () => {
    const run = await mount();
    api.post.mockRejectedValueOnce(
      refusal(409, 'IMPORT_REFUSED', 'Synthetic refusal.'),
    );

    run.start();
    await runWith(run, {
      allow_empty: true,
      confirm_replace: true,
      file: pick,
    });

    expect(run.failure).toMatchObject({ code: 'IMPORT_REFUSED', ok: false });

    run.start();

    expect(run.values).toEqual({});

    run.cancel();
    run.retry();

    expect(run.dialogOpen).toBeTruthy();
    expect(run.values).toEqual({ file: pick });

    await runWith(run, { confirm_replace: true, file: pick });

    expect(run.failure).toBeNull();

    run.retry();

    expect(run.dialogOpen).toBe(false);
  });
});

describe('the Run operation status read', () => {
  test('says why Run waits when the status cannot be read, and reads it again', async () => {
    vi.useFakeTimers();
    statusAnswers.push(() =>
      Promise.reject(new Error('synthetic network failure')),
    );
    const run = await mount();

    expect(run.canRun).toBe(false);
    expect(run.statusProblem).toBe(
      'The data status could not be read (NO_ANSWER); Run waits for it and reads it again shortly.',
    );

    await vi.advanceTimersByTimeAsync(pollMs);

    expect(run.statusProblem).toBeNull();
    expect(run.isAdmin).toBeTruthy();
    expect(run.canRun).toBeTruthy();
  });

  test('does not read again after a refusal', async () => {
    vi.useFakeTimers();
    statusAnswers.push(() =>
      Promise.reject(refusal(403, 'FORBIDDEN', 'Synthetic refusal.')),
    );
    const run = await mount();

    expect(run.statusProblem).toBe(
      'You may not read the data status; data operations are for administrators.',
    );
    expect(statusReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * pollMs);

    expect(statusReads()).toBe(1);
    expect(run.canRun).toBe(false);
  });
});
