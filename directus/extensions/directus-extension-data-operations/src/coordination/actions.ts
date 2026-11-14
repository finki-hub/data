import { randomUUID } from 'node:crypto';

import type { CoordinatorInput } from './options.js';
import type { CoordinationPort } from './port.js';

import { indexPageAction } from '../history-index.js';
import {
  type ActionContext,
  recoverInside,
  unreachable,
} from './action-support.js';
import { currentFor, decideClaim } from './decisions.js';
import { type Domain } from './domains.js';
import { isLockUnavailable } from './errors.js';
import { completeAction, failAction } from './release-actions.js';
import {
  heartbeatAction,
  planPagesAction,
  stagePageAction,
} from './run-actions.js';
import { claimLockWaitMs } from './state.js';
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
// written under the same lock with a fresh token. The answer names the
// claimed domain, which for next_calculation is the one the decision
// picked. An idle answer (busy, nothing pending, upstream dirty, failed)
// reads the singleton and the Flow graph only, never a collection.
const takeClaim = async (
  port: CoordinationPort,
  input: Extract<CoordinatorInput, { action: 'claim' }>,
  context: ActionContext,
) => {
  await port.ensureSingleton();
  const { state } = await recoverInside(port, context);
  const fingerprints = await port.currentFingerprints();
  const decision = decideClaim(state, {
    currentFingerprints: fingerprints,
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
      // A claim runs under the fingerprint of its domain's kind.
      const fingerprint = currentFor(fingerprints, decision.domain);
      const taken = await port.takeClaim({
        dirtyDomains: decision.dirtyDomains,
        domain: decision.domain,
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
        domain: decision.domain,
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
        domain: decision.domain,
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

// The claim waits a bounded time for the singleton row lock: behind a
// long source transaction (which holds it until its commit) a tick answers
// busy at once instead of holding a pooled connection for the whole wait.
const claimAction = async (
  input: Extract<CoordinatorInput, { action: 'claim' }>,
  context: ActionContext,
) => {
  try {
    return await context.store.transaction(async (port) => {
      await port.limitLockWait(claimLockWaitMs);
      return takeClaim(port, input, context);
    });
  } catch (error) {
    if (isLockUnavailable(error)) {
      return { claimed: false, reason: 'busy' };
    }
    throw error;
  }
};

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
    case 'index_page':
      return indexPageAction(input, context);
    case 'mark':
      return markAction(input.domains, context);
    case 'plan_pages':
      return planPagesAction(
        { source: input.source, token: input.token },
        context,
      );
    case 'stage_page':
      return stagePageAction(input, context);
    case 'status':
      return statusAction(context);
    default:
      return unreachable(input);
  }
};
