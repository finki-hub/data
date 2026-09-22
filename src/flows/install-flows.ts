import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

import { type FlowTemplate, insertionOrder } from './flow-template.js';

const json = (body: unknown, method: 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

const flowListing = z.array(
  z.object({ id: z.string(), operation: z.string().nullable() }),
);

// A template Flow whose entry operation is missing: an earlier install
// stopped between creating it and wiring its entry. The installer never
// repairs or overwrites an existing Flow, so it stops and names the remedy.
export class IncompleteFlowError extends Error {
  public override readonly name = 'IncompleteFlowError';

  public constructor(
    flow: { readonly id: string; readonly name: string },
    options?: ErrorOptions,
  ) {
    super(
      `The Flow "${flow.name}" (${flow.id}) exists without its entry operation: an earlier npm run setup or npm run import stopped while installing it. Delete that Flow in Studio (Settings > Flows), then run the command again.`,
      options,
    );
  }
}

export type FlowInstallSummary = {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
};

// Installs each template Flow once, in the given order: a Flow whose id
// exists is left exactly as it is, whatever Studio changed in it (options,
// operations, status), unless its entry operation is missing (a
// half-finished install, refused with IncompleteFlowError). A new Flow is
// created inactive, gets its operations (every edge target first), then its
// entry and activation in one PATCH. The repository definitions are
// bootstrap templates; the database owns every installed Flow.
export const installFlowTemplates = async (
  request: DirectusRequest,
  templates: readonly FlowTemplate[],
): Promise<FlowInstallSummary> => {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const flow of templates) {
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
