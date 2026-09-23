import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import { coordinatorActions } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import { flowFamilyCodes, insertionOrder } from '../src/flows/flow-template.js';
import { historyFlowIds } from '../src/flows/history-page-flows.js';
import {
  describeFailureScript,
  pagesWithTokenScript,
  splitEntriesScript,
  summaryScript,
} from '../src/flows/history-script.js';
import { historyIndexFlows } from '../src/flows/index-histories.js';
import { IncompleteFlowError } from '../src/flows/install-flows.js';
import { installFlowFamily } from '../src/flows/registry.js';

const coordinateType = 'finki-hub-data-coordinate';
const triggerClaim = '{{ $trigger.claim }}';
const knownActions: readonly string[] = coordinatorActions;
const cyclePattern = /cycle/u;
const collator = new Intl.Collator('en');
const uuidPattern = /^[0-9a-f-]{36}$/u;
const flowBody = z.object({ id: z.string(), status: z.string() });

const operations = historyIndexFlows.flatMap((flow) =>
  flow.operations.map((step) => ({ ...step, flow: flow.id })),
);
const byKey = new Map(
  operations.map((step) => [`${step.flow}/${step.key}`, step]),
);
const refreshTemplate = historyIndexFlows.find(
  ({ id }) => id === historyFlowIds.refresh,
);
const refreshStep = (key: string) =>
  byKey.get(`${historyFlowIds.refresh}/${key}`);
const refreshKeyOf = (id: null | string | undefined) =>
  refreshTemplate?.operations.find((candidate) => candidate.id === id)?.key;

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
      'heartbeat',
      'index_page',
      'plan_pages',
      'complete',
      'fail',
      'fail',
      'fail',
      'fail',
    ]);
    expect(
      coordinate.every(({ options }) =>
        knownActions.includes(String(options['action'])),
      ),
    ).toBeTruthy();

    // A page checks its claim before it reads: a page left over after an
    // overtaking or a failure stops without touching moodle_users.
    const pageStep = (key: string) =>
      byKey.get(`${historyFlowIds.page}/${key}`);

    expect(historyIndexFlows[0]?.entry).toBe(pageStep('check_claim')?.id);
    expect(pageStep('check_claim')).toMatchObject({
      options: { action: 'heartbeat', token: triggerClaim },
      reject: pageStep('claim_failed')?.id,
      resolve: pageStep('read_histories')?.id,
    });
    expect(pageStep('claim_failed')?.options).toEqual({
      json: {
        code: '{{ $last.code }}',
        message: '{{ $last.message }}',
        ok: false,
        page: '{{ $trigger.token }}',
        stage: 'claim',
      },
    });
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
      token: triggerClaim,
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
    expect(byKey.get(`${historyFlowIds.refresh}/index`)?.options).toEqual({
      flow: historyFlowIds.run,
      iterationMode: 'serial',
      payload: { token: triggerClaim },
    });
  });

  test('declare every history flow as an operation-triggered child; no manual runner remains', () => {
    expect(historyIndexFlows.map(({ id }) => id)).toEqual([
      historyFlowIds.page,
      historyFlowIds.run,
      historyFlowIds.refresh,
    ]);

    for (const flow of historyIndexFlows) {
      expect(flow.trigger).toBe('operation');
      expect(flow.options).toEqual({ return: '$last' });
    }
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

describe('refresh template', () => {
  test('complete the claim after every page indexed, otherwise fail it with a described cause', () => {
    expect(refreshKeyOf(refreshTemplate?.entry)).toBe('index');
    expect(refreshKeyOf(refreshStep('index')?.resolve)).toBe('index_ok');
    expect(refreshStep('index_ok')?.options).toEqual({
      filter: { index: { ok: { _eq: true } } },
    });
    expect(refreshKeyOf(refreshStep('index_ok')?.resolve)).toBe('complete');
    expect(refreshStep('complete')?.options).toEqual({
      action: 'complete',
      token: triggerClaim,
    });
    expect(refreshKeyOf(refreshStep('complete')?.resolve)).toBe('answer');
    expect(refreshStep('answer')?.options).toEqual({
      json: {
        completed: true,
        domain: 'history_index',
        index: '{{ index }}',
        ok: true,
        revision: '{{ complete.revision }}',
      },
    });

    // A failed page is described, the claim failed with that description,
    // and the uniform failure record answered.
    expect(refreshKeyOf(refreshStep('index_ok')?.reject)).toBe('describe');
    expect(refreshStep('describe')?.options).toEqual({
      code: describeFailureScript,
    });
    expect(refreshKeyOf(refreshStep('describe')?.resolve)).toBe('index_fail');
    expect(refreshStep('index_fail')?.options).toEqual({
      action: 'fail',
      code: 'INDEX_FAILED',
      message: '{{ describe }}',
      token: triggerClaim,
    });
    expect(refreshKeyOf(refreshStep('index_fail')?.resolve)).toBe(
      'index_failed',
    );
    expect(refreshStep('index_failed')?.options).toEqual({
      json: {
        code: 'INDEX_FAILED',
        message: '{{ describe }}',
        ok: false,
        stage: 'index',
      },
    });

    // Every other rejection fails the claim too: nothing is left for the
    // stale window to release.
    expect(refreshKeyOf(refreshStep('index')?.reject)).toBe('run_fail');
    expect(refreshKeyOf(refreshStep('describe')?.reject)).toBe('describe_fail');
    expect(refreshKeyOf(refreshStep('complete')?.reject)).toBe('complete_fail');
    expect(refreshStep('complete_fail')?.options).toMatchObject({
      action: 'fail',
      code: 'COMPLETION_REFUSED',
      message: '{{ complete.message }}',
    });
    expect(refreshStep('complete_failed')?.options).toMatchObject({
      json: { code: '{{ complete.code }}', ok: false, stage: 'complete' },
    });

    const rejecting = (refreshTemplate?.operations ?? []).filter(
      ({ reject }) => reject !== null,
    );

    expect(
      rejecting
        .map(({ key }) => key)
        .toSorted((left, right) => collator.compare(left, right)),
    ).toEqual(['complete', 'describe', 'index', 'index_ok']);
    expect(
      (refreshTemplate?.operations ?? []).some(
        ({ options }) => options['action'] === 'claim',
      ),
    ).toBeFalsy();
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

    await expect(
      installFlowFamily(request, flowFamilyCodes.history),
    ).resolves.toMatchObject({
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

    await expect(
      installFlowFamily(request, flowFamilyCodes.history),
    ).resolves.toMatchObject({
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

    await expect(
      installFlowFamily(request, flowFamilyCodes.history),
    ).rejects.toThrow(IncompleteFlowError);
    await expect(
      installFlowFamily(request, flowFamilyCodes.history),
    ).rejects.toThrow(
      `The Flow "${first.name}" (${first.id}) exists without its entry operation`,
    );
    expect(mutations).toEqual([]);
  });
});
