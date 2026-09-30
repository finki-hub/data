import {
  coordinateOperation,
  flowFamilyCodes,
  operation,
  type OperationTemplate,
  publishId,
  raise,
} from './flow-template.js';
import { stepName } from './text-fragments.js';

// The step makers of "Publish / Public assets" (publish-public-assets.ts),
// in the publish family.

const family = flowFamilyCodes.publish;

// The publication claim's token, as the parent's claim step answers it.
export const claimToken = '{{ claim.token }}';

const token = claimToken;

// A refusal after the claim: the fail step releases it with a fixed code
// and the refused step's message (and the outcomes when files were
// attempted), then the Flow answers the error. The answer follows whether
// or not the release succeeds (a claim already released, by an overtaking
// or by recovery, answers claim_mismatch there and keeps its release).
export const refusal = (spec: {
  readonly column: number;
  readonly error: { readonly code: string; readonly status: number };
  readonly fail: Readonly<Record<string, string>>;
  readonly key: string;
  readonly message: string;
  readonly suffixes: readonly [string, string];
}): OperationTemplate[] => [
  operation({
    edges: {
      reject: publishId(spec.suffixes[1]),
      resolve: publishId(spec.suffixes[1]),
    },
    family,
    key: `${spec.key}_fail`,
    name: stepName.failClaim(spec.key),
    options: { action: 'fail', message: spec.message, token, ...spec.fail },
    position: [spec.column, 19],
    suffix: spec.suffixes[0],
    type: coordinateOperation,
  }),
  raise({
    error: { ...spec.error, message: spec.message },
    family,
    key: `raise_${spec.key}`,
    name: stepName.raise(spec.error.code),
    position: [spec.column, 37],
    suffix: spec.suffixes[1],
  }),
];

// One step of the main row: it resolves into the next step.
export const step = (spec: {
  readonly column: number;
  readonly key: string;
  readonly name: string;
  readonly next: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly reject: string;
  readonly suffix: string;
  readonly type: string;
}): OperationTemplate =>
  operation({
    edges: { reject: publishId(spec.reject), resolve: publishId(spec.next) },
    family,
    key: spec.key,
    name: spec.name,
    options: spec.options,
    position: [spec.column, 1],
    suffix: spec.suffix,
    type: spec.type,
  });
