import assert from 'node:assert/strict';

import { markPendingFlowId } from '../../src/flows/mark-pending.js';
import { processPendingFlowId } from '../../src/flows/process-pending.js';
import { publishFileFlow } from '../../src/flows/publish-one-file.js';
import {
  publishAssetsFlow,
  publishAssetsFlowId,
} from '../../src/flows/publish-public-assets.js';
import { templateFingerprints } from '../automatic-processing-helpers.js';
import {
  calculations,
  databaseContainer,
  psql,
  settle,
} from './automatic-processing-helpers.mjs';
import { get, patch, status } from './history-index-helpers.mjs';

// The Flow-graph fingerprints of Task 15 on the installed project: a
// calculation graph and a publication graph, the publication one including
// the calculation fingerprint; Mark pending (mark and status only) in
// neither. Every edit is restored.

// Every installed Flow as a template: what the partition rule reads.
const liveTemplates = async (target) => {
  const flows = await get(
    target,
    '/flows?fields=id,trigger,options,operation&limit=-1',
  );
  const operations = await get(
    target,
    '/operations?fields=id,flow,key,type,options,resolve,reject&limit=-1',
  );
  return flows.map((flow) => ({
    entry: flow.operation,
    id: flow.id,
    operations: operations
      .filter((operation) => operation.flow === flow.id)
      .map(({ id, key, options, reject, resolve, type }) => ({
        id,
        key,
        options,
        reject,
        resolve,
        type,
      })),
    options: flow.options,
    trigger: flow.trigger,
  }));
};

const assertCalculationsCurrent = (report) => {
  for (const domain of calculations) {
    assert.equal(report.domains[domain].current, true, domain);
  }
};

// A dialog-only edit, then a publish-step edit, each restored.
export const partitionsFingerprints = async (t, target) => {
  const settled = await settle(target);
  const base = settled.report.fingerprints.current;
  // The SQL rule and the same rule over the installed Flows in this
  // process agree: one partition, applied to what Directus stored.
  assert.deepEqual(
    templateFingerprints(await liveTemplates(target)),
    base,
    'graphSql partitions the installed Flows as graphKindsOf does',
  );

  const markPending = await get(
    target,
    `/flows/${markPendingFlowId}?fields=options`,
  );
  await patch(target, `/flows/${markPendingFlowId}`, {
    options: {
      ...markPending.options,
      confirmationDescription: 'Synthetic reworded confirmation (Task 15).',
    },
  });
  try {
    const reworded = await status(target);
    assert.deepEqual(reworded.fingerprints.current, base);
    assert.deepEqual(reworded.pending, settled.report.pending);
  } finally {
    await patch(target, `/flows/${markPendingFlowId}`, {
      options: markPending.options,
    });
  }

  const upload = publishFileFlow.operations.find(({ key }) => key === 'upload');
  assert.ok(upload);
  // Saved the way Studio's Flow editor saves an edited operation: a nested
  // update of the Flow's operations carrying the drawer's options object.
  await patch(target, `/flows/${publishFileFlow.id}`, {
    operations: {
      create: [],
      delete: [],
      update: [
        {
          id: upload.id,
          options: { ...upload.options, synthetic_note: 'Task 15' },
        },
      ],
    },
  });
  try {
    const edited = await status(target);
    assert.equal(edited.fingerprints.current.calculation, base.calculation);
    assert.notEqual(edited.fingerprints.current.publication, base.publication);
    assert.ok(edited.pending.includes('publication'));
    assertCalculationsCurrent(edited);
    t.diagnostic(
      `publish-step edit: calculation ${base.calculation.slice(0, 8)} kept, publication ${base.publication.slice(0, 8)} -> ${edited.fingerprints.current.publication.slice(0, 8)}`,
    );
  } finally {
    await patch(target, `/operations/${upload.id}`, {
      options: upload.options,
    });
  }
  const restored = await status(target);
  assert.deepEqual(restored.fingerprints.current, base);
  assertCalculationsCurrent(restored);
};

// What the fingerprint query reads, straight from directus_operations: the
// options column holds the action and the claimed domain as JSON text
// fields, as the Studio operation form saves them.
export const storesClaimOptions = async (t, target) => {
  assert.ok(databaseContainer);
  // The publish claim step saved again the way Studio's Flow editor does
  // (its drawer's options object, unchanged), then read back.
  const claim = publishAssetsFlow.operations.find(({ key }) => key === 'claim');
  assert.ok(claim);
  await patch(target, `/flows/${publishAssetsFlowId}`, {
    operations: {
      create: [],
      delete: [],
      update: [{ id: claim.id, options: { ...claim.options } }],
    },
  });
  const rows = await psql(
    `SELECT f."id", pg_typeof(o."options")::text, o."options"->>'action', o."options"->>'domain' FROM "directus_operations" o JOIN "directus_flows" f ON f."id" = o."flow" WHERE o."type" = 'finki-hub-data-coordinate' AND o."key" = 'claim' AND f."id" IN ('${processPendingFlowId}', '${publishAssetsFlowId}') ORDER BY f."id"`,
  );
  t.diagnostic(`claim steps ${JSON.stringify(rows)}`);
  assert.deepEqual(rows, [
    [processPendingFlowId, 'json', 'claim', 'next_calculation'],
    [publishAssetsFlowId, 'json', 'claim', 'publication'],
  ]);
};
