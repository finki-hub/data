import { randomUUID } from 'node:crypto';

import type { CoordinatorInput } from './options.js';
import type { CoordinationPort } from './port.js';
import type { Domain } from './state.js';

import {
  type ActionContext,
  recoverInside,
  unreachable,
} from './action-support.js';
import { decideClaim } from './decisions.js';
import {
  completeAction,
  failAction,
  heartbeatAction,
  planPagesAction,
  stagePageAction,
} from './run-actions.js';
import { statusAction } from './status.js';

export const recoverAction = (context: ActionContext) =>
  context.store.transaction(async (port) => {
    const { released, state } = await recoverInside(port, context);
    return { owner: context.owner, released, revision: state.sourceRevision };
  });

const markAction = (domains: readonly Domain[], context: ActionContext) =>
  context.store.transaction(async (port) => {
    await port.ensureSingleton();
    const result = await port.markDomains(domains);
    return { domains: result.dirtyDomains, revision: result.sourceRevision };
  });

// One job only: the singleton row is locked, an abandoned claim is released
// first, then the decision is taken over the locked state and the claim is
// written under the same lock with a fresh token.
const takeClaim = async (
  port: CoordinationPort,
  input: Extract<CoordinatorInput, { action: 'claim' }>,
  context: ActionContext,
) => {
  await port.ensureSingleton();
  const { state } = await recoverInside(port, context);
  const fingerprint = await port.currentFingerprint();
  const decision = decideClaim(state, {
    currentFingerprint: fingerprint,
    domain: input.domain,
    retry: input.retry,
  });
  switch (decision.kind) {
    case 'busy':
      return {
        claimed: false,
        domain: decision.claim.domain,
        owner: decision.claim.owner,
        reason: 'busy',
      };
    case 'claim': {
      const token = randomUUID();
      const taken = await port.takeClaim({
        dirtyDomains: decision.dirtyDomains,
        domain: input.domain,
        fingerprint,
        owner: context.owner,
        sourceRevision: state.sourceRevision,
        token,
      });
      if (!taken) {
        return { claimed: false, reason: 'busy' };
      }
      return {
        claimed: true,
        domains: decision.dirtyDomains,
        fingerprint,
        owner: context.owner,
        revision: state.sourceRevision,
        token,
      };
    }
    case 'failed':
      return {
        claimed: false,
        error: decision.error.code,
        reason: 'failed',
        revision: decision.error.revision,
      };
    case 'nothing_pending':
      return { claimed: false, reason: 'nothing_pending' };
    case 'upstream_dirty':
      return {
        blocking: decision.blocking,
        claimed: false,
        reason: 'upstream_dirty',
      };
    default:
      return unreachable(decision);
  }
};

const claimAction = (
  input: Extract<CoordinatorInput, { action: 'claim' }>,
  context: ActionContext,
) => context.store.transaction((port) => takeClaim(port, input, context));

// Dispatches one validated action. Every action is one short transaction
// (two when an overtaken run has to be released).
export const runAction = (
  input: CoordinatorInput,
  context: ActionContext,
): Promise<unknown> => {
  switch (input.action) {
    case 'claim':
      return claimAction(input, context);
    case 'complete':
      return completeAction(input, context);
    case 'fail':
      return failAction(input, context);
    case 'heartbeat':
      return heartbeatAction(input.token, context);
    case 'mark':
      return markAction(input.domains, context);
    case 'plan_pages':
      return planPagesAction(input, context);
    case 'stage_page':
      return stagePageAction(input, context);
    case 'status':
      return statusAction(context);
    default:
      return unreachable(input);
  }
};
