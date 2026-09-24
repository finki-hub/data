import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

import { derivedDataFlowId } from './derived-data-flow.js';
import { flowTemplates } from './flows/registry.js';
import { publicAssetsFlowId } from './public-assets-flow.js';

// The operation types of the checkpoint derivation and publication: the
// Rebuild derived data extension operation and the storage writer of the
// Publish public assets Flow, which the checkpoint installs as
// finki-hub-publish-json (finki-hub-publish-public-assets is the name an
// earlier draft of the checkpoint used). A Flow is recognised by these
// types, never by its name or id, so a renamed or re-created one counts.
export const legacyOperationTypes: ReadonlySet<string> = new Set([
  'finki-hub-publish-json',
  'finki-hub-publish-public-assets',
  'finki-hub-rebuild-derived-data',
]);

// The stable ids under which the workbook import installs the two Flows;
// a Flow under one of them is the import's own, not a duplicate.
export const checkpointTemplateIds: ReadonlySet<string> = new Set([
  derivedDataFlowId,
  publicAssetsFlowId,
]);

// The Flows setup installs under stable ids (every registered family). The
// relational publish child writes through the same storage operation as
// the checkpoint Publish public assets Flow, but it is setup's own, never
// a checkpoint Flow of an old deployment.
export const managedTemplateIds: ReadonlySet<string> = new Set(
  flowTemplates().map(({ id }) => id),
);

// Whether a Flow runs the checkpoint derivation or publication: one of its
// operations has a legacy type and setup does not own its id.
export const isLegacyFlow = (id: string, types: readonly string[]): boolean =>
  !managedTemplateIds.has(id) &&
  types.some((type) => legacyOperationTypes.has(type));

const operationRows = z.array(
  z.object({ flow: z.string().nullable(), type: z.string() }),
);
const flowRows = z.array(
  z.object({ id: z.string(), name: z.string(), status: z.string() }),
);

export type LegacyFlow = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly types: readonly string[];
};

// Flows that run the checkpoint derivation or publication under an id the
// import does not own: an old deployment's Rebuild derived data or Publish
// public assets, whatever they are called now. Reads only.
export const findLegacyFlows = async (
  request: DirectusRequest,
): Promise<readonly LegacyFlow[]> => {
  const operations = operationRows.parse(
    await request('/operations?fields=flow,type&limit=-1'),
  );
  const types = new Map<string, Set<string>>();
  for (const { flow, type } of operations) {
    if (
      flow === null ||
      !isLegacyFlow(flow, [type]) ||
      checkpointTemplateIds.has(flow)
    ) {
      continue;
    }
    types.set(flow, (types.get(flow) ?? new Set()).add(type));
  }
  if (types.size === 0) {
    return [];
  }
  const flows = flowRows.parse(
    await request('/flows?fields=id,name,status&limit=-1'),
  );
  return flows
    .filter(({ id }) => types.has(id))
    .map((flow) => ({ ...flow, types: [...(types.get(flow.id) ?? [])] }));
};

// The workbook import refused a project holding checkpoint Flows of its
// own before its first write: it would install its stable-id Rebuild and
// Publish Flows beside them, two Flows of each name.
export class LegacyFlowsError extends Error {
  public override readonly name = 'LegacyFlowsError';

  public constructor(public readonly flows: readonly LegacyFlow[]) {
    const listed = flows
      .map(
        (flow) =>
          `"${flow.name}" (${flow.id}, ${flow.status}, ${flow.types.join(' + ')})`,
      )
      .join(', ');
    super(
      `The project holds ${String(flows.length)} Flow(s) that run the checkpoint derivation or publication under an id the import does not own: ${listed}. The one-time import installs its own Rebuild derived data and Publish public assets Flows and would run beside them with the same names; nothing was written. Keep a copy of any change made to those Flows, delete them in Studio (Settings > Flows) and import again, or upgrade the project with npm run migrate -- --dry-run --report <private path> instead.`,
    );
  }
}
