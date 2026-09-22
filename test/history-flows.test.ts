import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import { coordinatorActions } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import { insertionOrder } from '../src/flows/flow-template.js';
import { historyFlowIds } from '../src/flows/history-page-flows.js';
import {
  describeFailureScript,
  pagesWithTokenScript,
  splitEntriesScript,
  summaryScript,
} from '../src/flows/history-script.js';
import {
  historyIndexFlows,
  IncompleteFlowError,
  installHistoryIndexFlows,
} from '../src/flows/index-histories.js';

const coordinateType = 'finki-hub-data-coordinate';
const throwError = 'throw-error';
const knownActions: readonly string[] = coordinatorActions;
const cyclePattern = /cycle/u;
const uuidPattern = /^[0-9a-f-]{36}$/u;
const flowBody = z.object({ id: z.string(), status: z.string() });

const operations = historyIndexFlows.flatMap((flow) =>
  flow.operations.map((step) => ({ ...step, flow: flow.id })),
);
const byKey = new Map(
  operations.map((step) => [`${step.flow}/${step.key}`, step]),
);
const runnerTemplate = historyIndexFlows.find(
  ({ id }) => id === historyFlowIds.runner,
);
const runnerStep = (key: string) =>
  byKey.get(`${historyFlowIds.runner}/${key}`);
const runnerKeyOf = (id: null | string | undefined) =>
  runnerTemplate?.operations.find((candidate) => candidate.id === id)?.key;

describe('flow templates', () => {
  test('use unique deterministic ids, unique keys per flow and edges inside the flow', () => {
    const ids = [
      ...historyIndexFlows.map(({ id }) => id),
      ...operations.map(({ id }) => id),
    ];

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => uuidPattern.test(id))).toBeTruthy();

    for (const flow of historyIndexFlows) {
      const keys = flow.operations.map(({ key }) => key);
      const own = new Set(flow.operations.map(({ id }) => id));

      expect(new Set(keys).size).toBe(keys.length);
      expect(own.has(flow.entry)).toBeTruthy();
      expect(flow.accountability).toBe('activity');

      // A Flow is a tree: Directus keeps every resolve and every reject
      // target unique, so no operation is reached by two edges.
      for (const edge of ['resolve', 'reject'] as const) {
        const targets = flow.operations
          .map((step) => step[edge])
          .filter((target) => target !== null);

        expect(new Set(targets).size).toBe(targets.length);
      }

      for (const step of flow.operations) {
        expect(step.resolve === null || own.has(step.resolve)).toBeTruthy();
        expect(step.reject === null || own.has(step.reject)).toBeTruthy();
        expect(Number.isSafeInteger(step.position_x)).toBeTruthy();
        expect(Number.isSafeInteger(step.position_y)).toBeTruthy();
      }

      // No two operation cards share a place on the Studio canvas.
      const places = flow.operations.map(
        ({ position_x, position_y }) => `${position_x}/${position_y}`,
      );

      expect(new Set(places).size).toBe(places.length);
    }
  });

  test('wire plan, serial page indexing, exact splitting and the narrow writer', () => {
    const coordinate = operations.filter(({ type }) => type === coordinateType);

    expect(coordinate.map(({ options }) => options['action'])).toEqual([
      'index_page',
      'plan_pages',
      'claim',
      'fail',
      'complete',
    ]);
    expect(
      coordinate.every(({ options }) =>
        knownActions.includes(String(options['action'])),
      ),
    ).toBeTruthy();
    expect(byKey.get(`${historyFlowIds.page}/read_histories`)?.options).toEqual(
      {
        collection: 'moodle_users',
        emitEvents: false,
        permissions: '$full',
        query: {
          fields: ['id', 'Courses'],
          filter: {
            id: { _between: ['{{ $trigger.from }}', '{{ $trigger.to }}'] },
          },
          limit: -1,
          sort: ['id'],
        },
      },
    );
    expect(byKey.get(`${historyFlowIds.page}/split_entries`)?.options).toEqual({
      code: splitEntriesScript,
    });
    expect(byKey.get(`${historyFlowIds.page}/index_page`)?.options).toEqual({
      action: 'index_page',
      page: '{{ $trigger.token }}',
      rows: '{{ split_entries }}',
      token: '{{ $trigger.claim }}',
    });
    expect(byKey.get(`${historyFlowIds.run}/with_token`)?.options).toEqual({
      code: pagesWithTokenScript,
    });
    expect(byKey.get(`${historyFlowIds.run}/summary`)?.options).toEqual({
      code: summaryScript,
    });
    expect(byKey.get(`${historyFlowIds.run}/index_pages`)?.options).toEqual({
      flow: historyFlowIds.page,
      iterationMode: 'serial',
      payload: '{{ with_token }}',
    });
    expect(byKey.get(`${historyFlowIds.runner}/index`)?.options).toMatchObject({
      flow: historyFlowIds.run,
      iterationMode: 'serial',
    });
  });

  test('declare the page and run flows as children and the runner as a manual flow', () => {
    const [page, run, runner] = historyIndexFlows;

    expect(page?.trigger).toBe('operation');
    expect(run?.trigger).toBe('operation');
    expect(page?.options).toEqual({ return: '$last' });
    expect(run?.options).toEqual({ return: '$last' });
    expect(runner?.trigger).toBe('manual');
    expect(runner?.options).toMatchObject({
      async: false,
      collections: ['moodle_users'],
      error_on_reject: true,
      requireSelection: false,
    });
  });

  test('order operations so every edge target exists before its source', () => {
    for (const flow of historyIndexFlows) {
      const order = insertionOrder(flow.operations);
      const seen = new Set<string>();

      expect(order).toHaveLength(flow.operations.length);

      for (const step of order) {
        expect(step.resolve === null || seen.has(step.resolve)).toBeTruthy();
        expect(step.reject === null || seen.has(step.reject)).toBeTruthy();

        seen.add(step.id);
      }
    }
    const [template] = operations;

    if (template === undefined) {
      throw new Error('no operation template');
    }

    expect(() =>
      insertionOrder([
        { ...template, id: 'a', reject: null, resolve: 'b' },
        { ...template, id: 'b', reject: 'a', resolve: null },
      ]),
    ).toThrow(cyclePattern);
  });
});

describe('runner template', () => {
  test('gate the runner on administrators and end every refusal in a throw-error', () => {
    expect(runnerKeyOf(runnerTemplate?.entry)).toBe('admin_only');
    expect(runnerStep('admin_only')).toMatchObject({
      options: { filter: { $accountability: { admin: { _eq: true } } } },
      type: 'condition',
    });
    expect(runnerKeyOf(runnerStep('admin_only')?.resolve)).toBe('claim');
    expect(
      runnerStep(runnerKeyOf(runnerStep('admin_only')?.reject) ?? ''),
    ).toMatchObject({
      options: { code: 'FORBIDDEN', status: 403 },
      type: throwError,
    });

    // Only "nothing pending" answers 200 without a run.
    expect(runnerKeyOf(runnerStep('claimed')?.reject)).toBe('up_to_date');
    expect(runnerStep('up_to_date')?.options).toEqual({
      filter: { claim: { reason: { _eq: 'nothing_pending' } } },
    });
    expect(runnerKeyOf(runnerStep('up_to_date')?.resolve)).toBe('not_claimed');
    expect(runnerKeyOf(runnerStep('up_to_date')?.reject)).toBe('failed_before');
    expect(
      runnerStep(runnerKeyOf(runnerStep('failed_before')?.resolve) ?? ''),
    ).toMatchObject({
      options: { code: 'RETRY_REQUIRED', status: 409 },
      type: throwError,
    });
    expect(
      runnerStep(runnerKeyOf(runnerStep('failed_before')?.reject) ?? ''),
    ).toMatchObject({
      options: { code: 'CLAIM_BUSY', status: 409 },
      type: throwError,
    });

    // A failed run is marked failed, described, then reported.
    expect(runnerKeyOf(runnerStep('index_ok')?.reject)).toBe('fail_run');
    expect(runnerKeyOf(runnerStep('fail_run')?.resolve)).toBe(
      'describe_failure',
    );
    expect(runnerStep('describe_failure')?.options).toEqual({
      code: describeFailureScript,
    });
    expect(
      runnerStep(runnerKeyOf(runnerStep('describe_failure')?.resolve) ?? ''),
    ).toMatchObject({
      options: {
        code: 'INDEX_FAILED',
        message: '{{ describe_failure }}',
        status: 500,
      },
      type: throwError,
    });
    expect(
      runnerTemplate?.operations
        .filter(({ type }) => type === throwError)
        .every(({ reject, resolve }) => reject === null && resolve === null),
    ).toBeTruthy();
  });
});

describe('flow installer', () => {
  test('install each flow once and never touch an existing one', async () => {
    const calls: Array<{ body: unknown; method: string; pathname: string }> =
      [];
    const present = new Set<string>();
    const request: DirectusRequest = async (pathname, init) => {
      const method = init?.method ?? 'GET';
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ body, method, pathname });
      if (method === 'GET') {
        const id = new URL(
          pathname,
          'https://fixture.example',
        ).searchParams.get('filter[id][_eq]');
        return id !== null && present.has(id)
          ? [{ id, operation: `${id}-entry` }]
          : [];
      }
      if (pathname === '/flows') {
        present.add(flowBody.parse(body).id);
      }
      return {};
    };

    await expect(installHistoryIndexFlows(request)).resolves.toEqual({
      created: historyIndexFlows.map(({ name }) => name),
      skipped: [],
    });

    const mutations = calls.filter(({ method }) => method !== 'GET');
    const flows = mutations.filter(({ pathname }) => pathname === '/flows');
    const patches = mutations.filter(({ method }) => method === 'PATCH');

    expect(flows.map(({ body }) => flowBody.parse(body).status)).toEqual([
      'inactive',
      'inactive',
      'inactive',
    ]);
    expect(
      mutations.filter(({ pathname }) => pathname === '/operations'),
    ).toHaveLength(operations.length);
    expect(patches.map(({ body }) => body)).toEqual(
      historyIndexFlows.map(({ entry }) => ({
        operation: entry,
        status: 'active',
      })),
    );

    calls.length = 0;

    await expect(installHistoryIndexFlows(request)).resolves.toEqual({
      created: [],
      skipped: historyIndexFlows.map(({ name }) => name),
    });
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  test('refuse a template flow left without its entry operation by an interrupted install', async () => {
    const [first] = historyIndexFlows;

    if (first === undefined) {
      throw new Error('no template');
    }

    const mutations: string[] = [];
    const request: DirectusRequest = async (pathname, init) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        mutations.push(pathname);
        return {};
      }
      return pathname.includes(first.id)
        ? [{ id: first.id, operation: null }]
        : [];
    };

    await expect(installHistoryIndexFlows(request)).rejects.toThrow(
      IncompleteFlowError,
    );
    await expect(installHistoryIndexFlows(request)).rejects.toThrow(
      `The Flow "${first.name}" (${first.id}) exists without its entry operation`,
    );
    expect(mutations).toEqual([]);
  });
});
