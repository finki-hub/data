import { describe, expect, test } from 'vitest';

import { publishFileFlowId } from '../src/flows/publish-one-file.js';
import { publishFlows } from '../src/flows/publish-public-assets.js';
import {
  findLegacyFlows,
  isLegacyFlow,
  legacyOperationTypes,
} from '../src/legacy-flows.js';
import { readInventory } from '../src/migrations/inventory.js';
import { preflight } from '../src/migrations/preflight.js';
import { publicAssetsFlowId } from '../src/public-assets-flow.js';
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
