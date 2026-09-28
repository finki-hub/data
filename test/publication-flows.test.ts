import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import { exportsOperationId } from '../directus/extensions/directus-extension-data-operations/src/exports/actions.js';
import {
  exportsOperation,
  flowFamilyCodes,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import {
  prepareAssetsFlow,
  prepareAssetsFlowId,
  publicationFlows,
} from '../src/flows/prepare-public-assets.js';
import { automaticProcessingFlows } from '../src/flows/process-pending.js';
import { installFlowFamily } from '../src/flows/registry.js';
import {
  validateReadinessFlow,
  validateReadinessFlowId,
} from '../src/flows/validate-readiness.js';
import { managedFlowIds } from './automatic-processing-helpers.js';

const stepOf = (
  flow: FlowTemplate,
  id: null | string | undefined,
): OperationTemplate | undefined =>
  flow.operations.find((operation) => operation.id === id);

const keyed = (flow: FlowTemplate, key: string): OperationTemplate => {
  const found = flow.operations.find((operation) => operation.key === key);
  if (found === undefined) {
    throw new Error(`${flow.name} has no ${key}`);
  }
  return found;
};

// The keys the resolve edges visit from the entry operation.
const resolvePath = (flow: FlowTemplate): string[] => {
  const keys: string[] = [];
  let current = stepOf(flow, flow.entry);
  while (current !== undefined) {
    keys.push(current.key);
    current = stepOf(flow, current.resolve);
  }
  return keys;
};

const adminGate = { $accountability: { admin: { _eq: true } } };

const byText = (left: string, right: string): number =>
  left.localeCompare(right);

const idsOf = (flow: FlowTemplate): string[] => [
  flow.id,
  ...flow.operations.map(({ id }) => id),
];

const button = {
  async: false,
  collections: ['data_operations'],
  error_on_reject: true,
  location: 'both',
  requireConfirmation: false,
  requireSelection: false,
};

describe.each([
  [validateReadinessFlow, 'readiness', 'Data / Validate readiness'],
  [prepareAssetsFlow, 'prepare', 'Publish / Prepare public assets'],
] as const)('%#: the thin publication Flow', (flow, action, name) => {
  test(`${name} is an administrators-only button on Data Operations`, () => {
    expect(flow).toMatchObject({
      accountability: 'activity',
      name,
      options: button,
      trigger: 'manual',
    });
    expect(keyed(flow, 'admin_only').options).toEqual({ filter: adminGate });
    expect(stepOf(flow, keyed(flow, 'admin_only').reject)).toMatchObject({
      options: { code: 'FORBIDDEN', status: 403 },
      type: 'throw-error',
    });
  });

  test(`${name} calls the export operation's ${action} action and nothing else`, () => {
    expect(resolvePath(flow)).toEqual(['admin_only', action]);
    expect(keyed(flow, action)).toMatchObject({
      options: { action },
      reject: null,
      resolve: null,
      type: exportsOperation,
    });
    // No read, script, upload or coordinator step: the definitions in the
    // extension decide what is read and published.
    expect(flow.operations.map(({ type }) => type).toSorted(byText)).toEqual([
      'condition',
      exportsOperation,
      'throw-error',
    ]);
  });
});

describe('the publication Flows', () => {
  test('call the operation the extension registers', () => {
    expect(exportsOperation).toBe(exportsOperationId);
  });

  test('take distinct ids of the publication family', () => {
    const ids = publicationFlows.flatMap(idsOf);

    expect(publicationFlows.map(({ id }) => id)).toEqual([
      validateReadinessFlowId,
      prepareAssetsFlowId,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.every((id) => id.startsWith('6a1d9f0e-2b3c-4d5e-8f70-0000000014')),
    ).toBeTruthy();
  });

  test('stay out of the managed Flow graph the calculation fingerprint covers', () => {
    const managed = managedFlowIds([
      ...publicationFlows,
      ...automaticProcessingFlows,
    ]);

    expect(publicationFlows.some(({ id }) => managed.has(id))).toBeFalsy();
  });
});

const flowBody = z.looseObject({ id: z.string(), status: z.string() });

const parsedBody = (init: Parameters<DirectusRequest>[1]): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : 'null');

// A Directus that has none of the Flows yet and records every Flow POST.
const recordingDirectus = () => {
  const posted: Array<z.infer<typeof flowBody>> = [];
  const request: DirectusRequest = async (pathname, init) => {
    if (init?.method === 'POST' && pathname === '/flows') {
      posted.push(flowBody.parse(parsedBody(init)));
    }
    return init?.method === undefined ? [] : {};
  };
  return { posted, request };
};

describe('installation', () => {
  test('installs both Flows once each, inactive until wired', async () => {
    const { posted, request } = recordingDirectus();

    await expect(
      installFlowFamily(request, flowFamilyCodes.publication),
    ).resolves.toMatchObject({
      created: ['Data / Validate readiness', 'Publish / Prepare public assets'],
      skipped: [],
    });
    expect(posted.map(({ status }) => status)).toEqual([
      'inactive',
      'inactive',
    ]);
  });
});
