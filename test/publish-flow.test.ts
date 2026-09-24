import { describe, expect, test } from 'vitest';

import { declaredFilenames } from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import {
  coordinateOperation,
  exportsOperation,
  familyId,
  flowFamilyCodes,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import {
  publishFileFlow,
  publishFileFlowId,
} from '../src/flows/publish-one-file.js';
import {
  publishAssetsFlow,
  publishAssetsFlowId,
  publishFlows,
} from '../src/flows/publish-public-assets.js';
import { flowFamilies, flowTemplates } from '../src/flows/registry.js';

const publishJson = 'finki-hub-publish-json';
const boundedCode = /^[A-Z][A-Z_]{0,63}$/u;

const stepOf = (flow: FlowTemplate, key: string): OperationTemplate => {
  const step = flow.operations.find((operation) => operation.key === key);
  if (step === undefined) {
    throw new Error(`${flow.name} has no step ${key}`);
  }
  return step;
};

const byId = (flow: FlowTemplate, id: null | string) =>
  flow.operations.find((operation) => operation.id === id) ?? null;

const keyOf = (flow: FlowTemplate, id: null | string): null | string =>
  byId(flow, id)?.key ?? null;

// The steps reached from a step, following both edges.
const reachable = (flow: FlowTemplate, from: string): Set<string> => {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift() ?? '';
    const step = byId(flow, id);
    if (step === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const next of [step.resolve, step.reject]) {
      if (next !== null) {
        queue.push(next);
      }
    }
  }
  return seen;
};

describe('Publish / Public assets (relational)', () => {
  const flow = publishAssetsFlow;

  test('is an administrators-only manual button with a confirmation, answering synchronously', () => {
    expect(flow).toMatchObject({
      accountability: 'activity',
      id: publishAssetsFlowId,
      name: 'Publish / Public assets (relational)',
      trigger: 'manual',
    });
    expect(flow.options).toMatchObject({
      async: false,
      collections: ['data_operations'],
      error_on_reject: true,
      location: 'both',
      requireConfirmation: true,
      requireSelection: false,
    });
    expect(String(flow.options['confirmationDescription'])).toContain(
      'one after another',
    );
    expect(byId(flow, flow.entry)).toMatchObject({
      key: 'admin_only',
      options: { filter: { $accountability: { admin: { _eq: true } } } },
      type: 'condition',
    });
    expect(keyOf(flow, byId(flow, flow.entry)?.reject ?? null)).toBe(
      'raise_forbidden',
    );
    expect(stepOf(flow, 'raise_forbidden').options).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  test('claims publication, stages every declared file, loops serially, then records the outcome map', () => {
    expect(stepOf(flow, 'claim')).toMatchObject({
      options: { action: 'claim', domain: 'publication', retry: true },
      type: coordinateOperation,
    });
    expect(stepOf(flow, 'stage')).toMatchObject({
      options: {
        action: 'stage',
        revision: '{{ claim.revision }}',
        token: '{{ claim.token }}',
      },
      type: exportsOperation,
    });
    expect(stepOf(flow, 'publish_files')).toMatchObject({
      options: {
        flow: publishFileFlowId,
        iterationMode: 'serial',
        payload: '{{ stage.uploads }}',
      },
      type: 'trigger',
    });
    expect(stepOf(flow, 'outcomes')).toMatchObject({
      options: { action: 'outcomes', results: '{{ publish_files }}' },
      type: exportsOperation,
    });
    expect(stepOf(flow, 'all_uploaded').options).toEqual({
      filter: { outcomes: { ok: { _eq: true } } },
    });
    expect(stepOf(flow, 'complete')).toMatchObject({
      options: {
        action: 'complete',
        files: '{{ outcomes.files }}',
        token: '{{ claim.token }}',
      },
      type: coordinateOperation,
    });
    expect(stepOf(flow, 'record_failure')).toMatchObject({
      options: {
        action: 'fail',
        code: '{{ outcomes.code }}',
        files: '{{ outcomes.files }}',
        message: '{{ outcomes.message }}',
        token: '{{ claim.token }}',
      },
      type: coordinateOperation,
    });

    const main = [
      'admin_only',
      'claim',
      'claimed',
      'stage',
      'publish_files',
      'outcomes',
      'all_uploaded',
      'complete',
      'answer',
    ];

    expect(
      main.slice(0, -1).map((key) => keyOf(flow, stepOf(flow, key).resolve)),
    ).toEqual(main.slice(1));

    expect(keyOf(flow, stepOf(flow, 'all_uploaded').reject)).toBe(
      'record_failure',
    );
    expect(keyOf(flow, stepOf(flow, 'record_failure').resolve)).toBe(
      'raise_partial',
    );
    expect(stepOf(flow, 'raise_partial').options).toMatchObject({
      code: '{{ outcomes.code }}',
      message: '{{ outcomes.message }}',
    });
    // The prepared revision is published; an edit made meanwhile is
    // answered as still pending.
    expect(stepOf(flow, 'answer').options).toEqual({
      json: {
        files: '{{ outcomes.files }}',
        pendingRevision: '{{ complete.pendingRevision }}',
        published: true,
        revision: '{{ claim.revision }}',
        warnings: '{{ stage.warnings }}',
      },
    });
  });

  test('never leaves the claim held: every refusal after the claim fails it before answering', () => {
    const afterClaim = ['stage', 'publish_files', 'outcomes', 'complete'];
    const branches = afterClaim.map((key) => {
      const release = byId(flow, stepOf(flow, key).reject);
      const raised = byId(flow, release?.resolve ?? null);
      return {
        action: release?.options['action'],
        raised: raised?.type,
        rejectsToRaise: release?.reject === raised?.id,
        type: release?.type,
      };
    });

    expect(branches).toEqual(
      afterClaim.map(() => ({
        action: 'fail',
        raised: 'throw-error',
        rejectsToRaise: true,
        type: coordinateOperation,
      })),
    );
    // Recording the failure answers it whether or not the record succeeds.
    expect(stepOf(flow, 'record_failure').reject).toBe(
      stepOf(flow, 'raise_partial').id,
    );
    // A refused claim holds nothing to release.
    expect(byId(flow, stepOf(flow, 'claim').reject)?.type).toBe('throw-error');
    expect(byId(flow, stepOf(flow, 'claimed').reject)?.type).toBe(
      'throw-error',
    );
    // Every step is reachable from the entry, and none is orphaned.
    expect(reachable(flow, flow.entry).size).toBe(flow.operations.length);
  });
});

describe('Publish / One file', () => {
  const flow = publishFileFlow;

  test('is a child that answers its last step and never rejects', () => {
    expect(flow).toMatchObject({
      accountability: 'activity',
      id: publishFileFlowId,
      name: 'Publish / One file',
      options: { return: '$last' },
      trigger: 'operation',
    });

    const terminal = flow.operations.filter(
      ({ reject, resolve }) => reject === null && resolve === null,
    );

    expect(terminal.every(({ type }) => type === 'transform')).toBeTruthy();

    // Only transforms may end without a reject edge: they cannot throw.
    expect(
      flow.operations
        .filter(({ reject, type }) => type !== 'transform' && reject === null)
        .map(({ key }) => key),
    ).toEqual([]);
  });

  test('keeps the claim alive, uploads one file through the existing writer with a single-entry map, and records its outcome at once', () => {
    const claim = '{{ $trigger.claim }}';
    const filename = '{{ $trigger.filename }}';

    expect(byId(flow, flow.entry)).toMatchObject({
      key: 'keep_claim',
      options: { action: 'heartbeat', token: claim },
      type: coordinateOperation,
    });
    expect(stepOf(flow, 'upload')).toMatchObject({
      options: { objects: '{{ $trigger.objects }}', storage: 'publish' },
      type: publishJson,
    });
    expect(keyOf(flow, stepOf(flow, 'keep_claim').resolve)).toBe('upload');
    expect(keyOf(flow, stepOf(flow, 'keep_claim').reject)).toBe('claim_lost');
    expect(keyOf(flow, stepOf(flow, 'upload').resolve)).toBe('record_uploaded');
    expect(keyOf(flow, stepOf(flow, 'upload').reject)).toBe('record_failed');
    expect(stepOf(flow, 'record_uploaded')).toMatchObject({
      options: {
        action: 'record',
        bytes: '{{ upload.bytes }}',
        filename,
        outcome: 'uploaded',
        token: claim,
      },
      type: coordinateOperation,
    });
    expect(stepOf(flow, 'record_failed')).toMatchObject({
      options: {
        action: 'record',
        code: '{{ upload.code }}',
        filename,
        outcome: 'failed',
        token: claim,
      },
      type: coordinateOperation,
    });

    // A refused record still answers the upload: it happened all the same.
    for (const [record, answer] of [
      ['record_uploaded', 'uploaded'],
      ['record_failed', 'upload_failed'],
    ] as const) {
      expect(keyOf(flow, stepOf(flow, record).resolve)).toBe(answer);
      expect(keyOf(flow, stepOf(flow, record).reject)).toBe(answer);
    }

    expect(stepOf(flow, 'uploaded').options).toEqual({
      json: {
        bytes: '{{ upload.bytes }}',
        code: null,
        filename,
        ok: true,
        outcome: 'uploaded',
      },
    });
    expect(stepOf(flow, 'upload_failed').options).toEqual({
      json: {
        bytes: null,
        code: '{{ upload.code }}',
        filename,
        message: '{{ upload.message }}',
        ok: false,
        outcome: 'failed',
      },
    });
    // A claim that cannot be kept skips the upload with the heartbeat's
    // own code, whatever the cause.
    expect(stepOf(flow, 'claim_lost').options).toEqual({
      json: {
        bytes: null,
        code: '{{ keep_claim.code }}',
        filename,
        message: '{{ keep_claim.message }}',
        ok: false,
        outcome: 'skipped',
      },
    });
    expect(reachable(flow, flow.entry).size).toBe(flow.operations.length);
  });
});

describe('the publish family', () => {
  test('names no published file: a new export definition changes no Flow', () => {
    const text = JSON.stringify(publishFlows);

    for (const filename of declaredFilenames) {
      expect(text).not.toContain(filename);
    }
  });

  test('is registered once, child before parent, before automatic processing', () => {
    const codes = flowFamilies.map(({ code }) => code);

    expect(codes).toContain(flowFamilyCodes.publish);
    expect(codes.indexOf(flowFamilyCodes.publish)).toBeLessThan(
      codes.indexOf(flowFamilyCodes.automation),
    );
    expect(publishFlows.map(({ id }) => id)).toEqual([
      publishFileFlowId,
      publishAssetsFlowId,
    ]);
    expect(publishAssetsFlowId).toBe(familyId(flowFamilyCodes.publish, '01'));

    const ids = flowTemplates().map(({ id }) => id);

    expect(ids.indexOf(publishFileFlowId)).toBeLessThan(
      ids.indexOf(publishAssetsFlowId),
    );
  });

  test('fails the claim with bounded codes only', () => {
    const fails = publishFlows
      .flatMap(({ operations }) => operations)
      .filter(
        ({ options, type }) =>
          type === coordinateOperation && options['action'] === 'fail',
      );

    expect(fails.length).toBeGreaterThan(0);

    // A fixed code, or the outcomes action's own, which is one of
    // PUBLICATION_PARTIAL and PUBLICATION_FAILED.
    expect(
      fails
        .filter(
          ({ options }) =>
            !boundedCode.test(String(options['code'])) &&
            options['code'] !== '{{ outcomes.code }}',
        )
        .map(({ key }) => key),
    ).toEqual([]);
  });

  test('uploads nothing in parallel and retries nothing', () => {
    const operations = publishFlows.flatMap(({ operations: list }) => list);

    expect(
      operations
        .filter(({ type }) => type === 'trigger')
        .every(({ options }) => options['iterationMode'] === 'serial'),
    ).toBeTruthy();
    expect(operations.filter(({ type }) => type === publishJson)).toHaveLength(
      1,
    );

    // No edge leads back to an earlier step: the graphs are acyclic.
    for (const flow of publishFlows) {
      for (const step of flow.operations) {
        expect(reachable(flow, step.resolve ?? '').has(step.id)).toBeFalsy();
        expect(reachable(flow, step.reject ?? '').has(step.id)).toBeFalsy();
      }
    }
  });
});
