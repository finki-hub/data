import {
  type CalculationDomain,
  calculationDomains,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  automationId,
  condition,
  flowFamilyCodes,
  operation,
  type OperationTemplate,
} from './flow-template.js';
import {
  failStepId,
  type ReleaseBranch,
  releaseSteps,
} from './release-steps.js';

const family = flowFamilyCodes.automation;

const claimToken = '{{ claim.token }}';

// How the scheduler runs one calculation domain: the condition that
// recognises its claim, the child Flow it triggers with the claim, the
// check that the child answered, and the failure branches that release
// the claim when the child could not (its Trigger Flow step rejected, or
// it answered nothing because it is inactive or deleted).
export type CalculationRoute = {
  readonly answered: { readonly key: string; readonly suffix: string };
  readonly child: string;
  readonly crashed: ReleaseBranch;
  readonly missing: ReleaseBranch;
  readonly payload: Readonly<Record<string, string>>;
  readonly route: {
    readonly key: string;
    readonly name: string;
    readonly suffix: string;
  };
  readonly row: number;
  readonly run: {
    readonly key: string;
    readonly name: string;
    readonly suffix: string;
  };
};

export const branch = (
  spec: Pick<
    ReleaseBranch,
    'code' | 'message' | 'position' | 'stage' | 'suffixes'
  >,
): ReleaseBranch => ({ ...spec, family, token: claimToken });

// A claim of a domain no route runs (a domain declared later without a
// route, or a claim edited by hand): the scheduler fails it with its own
// code instead of handing it to a child that would refuse it for another
// reason.
export const unknownDomain = branch({
  code: 'DOMAIN_UNKNOWN',
  message:
    'The claim named the domain {{ claim.domain }}, which no route of "Data / Process pending" runs; the claim was released without a run.',
  position: [55, 109],
  stage: 'unknown_domain',
  suffixes: ['49', '4a'],
});

// The route steps in declaration order: each domain's condition rejects
// into the next domain's, the last one into the unknown-domain branch.
export const routeSteps = (
  routes: Readonly<Record<CalculationDomain, CalculationRoute>>,
): OperationTemplate[] => {
  const ordered = calculationDomains.map((domain) => ({
    domain,
    route: routes[domain],
  }));
  return ordered.flatMap(({ domain, route }, index) => {
    const next = ordered[index + 1]?.route.route.suffix;
    return [
      condition({
        edges: {
          reject:
            next === undefined ? failStepId(unknownDomain) : automationId(next),
          resolve: automationId(route.run.suffix),
        },
        family,
        filter: { claim: { domain: { _eq: domain } } },
        key: route.route.key,
        name: route.route.name,
        position: [55, route.row],
        suffix: route.route.suffix,
      }),
      operation({
        edges: {
          reject: failStepId(route.crashed),
          resolve: automationId(route.answered.suffix),
        },
        family,
        key: route.run.key,
        name: route.run.name,
        options: {
          flow: route.child,
          iterationMode: 'serial',
          payload: route.payload,
        },
        position: [73, route.row],
        suffix: route.run.suffix,
        type: 'trigger',
      }),
      condition({
        edges: { reject: failStepId(route.missing) },
        family,
        filter: { [route.run.key]: { ok: { _nnull: true } } },
        key: route.answered.key,
        name: 'Answered?',
        position: [91, route.row],
        suffix: route.answered.suffix,
      }),
      ...releaseSteps(route.crashed),
      ...releaseSteps(route.missing),
    ];
  });
};

export const unknownDomainSteps = (): OperationTemplate[] =>
  releaseSteps(unknownDomain);
