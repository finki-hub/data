import { describe, expect, test } from 'vitest';

import type { FlowTemplate } from '../src/flows/flow-template.js';

import { derivedDataFlow } from '../src/derived-data-flow.js';
import { publishFileFlowId } from '../src/flows/publish-one-file.js';
import { publishFlows } from '../src/flows/publish-public-assets.js';
import {
  findLegacyFlows,
  isLegacyFlow,
  legacyOperationTypes,
} from '../src/legacy-flows.js';
import { readInventory } from '../src/migrations/inventory.js';
import { preflight } from '../src/migrations/preflight.js';
import {
  publicAssetsFlow,
  publicAssetsFlowId,
} from '../src/public-assets-flow.js';
import { makeSyntheticDataset } from './fixtures/synthetic-data.js';
import { emptyStore, fakeImportDirectus } from './import-test-helpers.js';
import {
  fakeItemsDirectus,
  storeFromDataset,
} from './migration-test-helpers.js';

const publishJson = 'finki-hub-publish-json';

// The publish Flows setup installs write through the storage operation of
// the checkpoint Publish public assets Flow; setup owns them, so neither
// the one-time import's guard nor the migration preflight takes them for a
// checkpoint Flow of an old deployment.
describe('the Flows setup owns', () => {
  test('are never legacy Flows, whatever operation they use', () => {
    const types = publishFlows
      .flatMap(({ operations }) => operations)
      .map(({ type }) => type);

    expect(types.some((type) => legacyOperationTypes.has(type))).toBeTruthy();
    expect(isLegacyFlow(publishFileFlowId, [publishJson])).toBeFalsy();
    expect(isLegacyFlow('old-publish', [publishJson])).toBeTruthy();
    expect(isLegacyFlow(publicAssetsFlowId, [publishJson])).toBeTruthy();
    expect(isLegacyFlow('old-notification', ['transform'])).toBeFalsy();
  });

  test('leave the one-time import free to run', async () => {
    const store = emptyStore();
    for (const flow of publishFlows) {
      store.flows.push({ id: flow.id, name: flow.name, status: 'active' });
      store.operations.push(
        ...flow.operations.map(({ id, type }) => ({ flow: flow.id, id, type })),
      );
    }

    await expect(
      findLegacyFlows(fakeImportDirectus(store).request),
    ).resolves.toEqual([]);
  });

  test('are persisted Flows in the migration preflight, not legacy ones', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    store.flows.push({
      id: publishFileFlowId,
      name: 'Publish / One file',
      operation: 'op-p',
      status: 'active',
      trigger: 'operation',
    });
    store.operations.push({
      flow: publishFileFlowId,
      id: 'op-p',
      key: 'upload',
      options: {},
      reject: null,
      resolve: null,
      type: publishJson,
    });
    const { request } = fakeItemsDirectus(store);
    const report = preflight(await readInventory(request, {}), null);
    const codes = [...report.blockers, ...report.warnings]
      .filter(({ label }) => label === publishFileFlowId)
      .map(({ code }) => code);

    expect(codes).toEqual(['persisted_flow']);
  });
});

// The checkpoint Flows as the one-time import installs them, each starting
// with its Administrator? gate.
const checkpointFlows: readonly FlowTemplate[] = [
  derivedDataFlow,
  publicAssetsFlow(''),
];

const typesOf = (flow: FlowTemplate): string[] =>
  flow.operations.map(({ type }) => type);

describe('the checkpoint Flows the import installs, gate included', () => {
  test('are its own under their stable ids, so a later import runs', async () => {
    const store = emptyStore();
    for (const flow of checkpointFlows) {
      store.flows.push({ id: flow.id, name: flow.name, status: 'active' });
      store.operations.push(
        ...flow.operations.map(({ id, type }) => ({ flow: flow.id, id, type })),
      );
    }

    expect(typesOf(derivedDataFlow)).toContain('condition');
    await expect(
      findLegacyFlows(fakeImportDirectus(store).request),
    ).resolves.toEqual([]);
  });

  test('are still refused under any other id', async () => {
    const store = emptyStore();
    const copy = publicAssetsFlow('');
    store.flows.push({ id: 'old-publish', name: copy.name, status: 'active' });
    store.operations.push(
      ...copy.operations.map(({ id, type }) => ({
        flow: 'old-publish',
        id: `old-${id}`,
        type,
      })),
    );

    await expect(
      findLegacyFlows(fakeImportDirectus(store).request),
    ).resolves.toEqual([
      {
        id: 'old-publish',
        name: 'Publish public assets',
        status: 'active',
        types: [publishJson],
      },
    ]);
  });

  test('are legacy Flows in the migration preflight', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    for (const flow of checkpointFlows) {
      store.flows.push({
        id: flow.id,
        name: flow.name,
        operation: flow.entry,
        status: 'active',
        trigger: flow.trigger,
      });
      store.operations.push(
        ...flow.operations.map(
          ({ id, key, options, reject, resolve, type }) => ({
            flow: flow.id,
            id,
            key,
            options,
            reject,
            resolve,
            type,
          }),
        ),
      );
    }
    const { request } = fakeItemsDirectus(store);
    const report = preflight(await readInventory(request, {}), null);
    const labels = new Set(checkpointFlows.map(({ id }) => id));
    const codes = Object.fromEntries(
      [...report.blockers, ...report.warnings]
        .filter(({ label }) => label !== null && labels.has(label))
        .map(({ code, label }): [string, string] => [String(label), code]),
    );

    expect(
      checkpointFlows.map((flow) => isLegacyFlow(flow.id, typesOf(flow))),
    ).toEqual([true, true]);
    expect(codes).toEqual(
      Object.fromEntries(
        checkpointFlows.map(({ id }): [string, string] => [
          id,
          'legacy_flow_present',
        ]),
      ),
    );
  });
});
