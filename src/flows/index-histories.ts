import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

import { type FlowTemplate, insertionOrder } from './flow-template.js';
import { pageFlow, runFlow } from './history-page-flows.js';
import { runnerFlow } from './history-runner-flow.js';

// The Moodle history index Flows in installation order: the page Flow
// before the run Flow that calls it, the manual runner last.
export const historyIndexFlows: readonly FlowTemplate[] = [
  pageFlow,
  runFlow,
  runnerFlow,
];

const json = (body: unknown, method: 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

const flowListing = z.array(
  z.object({ id: z.string(), operation: z.string().nullable() }),
);

// A template Flow whose entry operation is missing: an earlier setup
// stopped between creating it and wiring its entry. Setup never repairs or
// overwrites an existing Flow, so it stops and names the remedy.
export class IncompleteFlowError extends Error {
  public override readonly name = 'IncompleteFlowError';

  public constructor(
    flow: { readonly id: string; readonly name: string },
    options?: ErrorOptions,
  ) {
    super(
      `The Flow "${flow.name}" (${flow.id}) exists without its entry operation: an earlier npm run setup stopped while installing it. Delete that Flow in Studio (Settings > Flows), then run npm run setup again.`,
      options,
    );
  }
}

export type FlowInstallSummary = {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
};

// Installs each Flow once: a Flow whose id exists is left exactly as it
// is, whatever Studio changed in it, unless its entry operation is missing
// (a half-finished install, refused with IncompleteFlowError). A new Flow
// is created inactive, gets its operations, then its entry and activation
// in one PATCH.
export const installHistoryIndexFlows = async (
  request: DirectusRequest,
): Promise<FlowInstallSummary> => {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const flow of historyIndexFlows) {
    const [existing] = flowListing.parse(
      await request(
        `/flows?fields=id,operation&limit=1&filter[id][_eq]=${flow.id}`,
      ),
    );
    if (existing !== undefined) {
      if (existing.operation === null) {
        throw new IncompleteFlowError(flow);
      }
      skipped.push(flow.name);
      continue;
    }
    const { entry, operations, ...definition } = flow;
    await request(
      '/flows',
      json({ ...definition, operation: null, status: 'inactive' }, 'POST'),
    );
    for (const step of insertionOrder(operations)) {
      await request('/operations', json({ ...step, flow: flow.id }, 'POST'));
    }
    await request(
      `/flows/${flow.id}`,
      json({ operation: entry, status: 'active' }, 'PATCH'),
    );
    created.push(flow.name);
  }
  return { created, skipped };
};
