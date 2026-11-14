import type { StatusReport } from './coordination/status.js';

import {
  domainDeclarations,
  domainLabel,
  isClaimDomain,
} from './coordination/domains.js';
import {
  type DomainView,
  type KeySourceView,
  type StatusView,
} from './status-contract.js';

// The data status as the dashboard shows it, built from the bounded
// coordinator status: every declared domain in dependency order, the
// key-source rows and the last
// run of each scheduled Flow. Lists come from the declarations and the
// reports, never from a fixed set. The last failure carries its stored
// text; the view never carries a token, a claim owner, a fingerprint or a
// record.

export type ScheduledRun = {
  readonly active: boolean;
  // Seconds since the last run by the database clock, null without one.
  readonly ageSeconds: null | number;
  readonly id: string;
  readonly lastRunAt: null | string;
  readonly name: string;
};

type StatusInputs = {
  readonly keySources: readonly KeySourceView[];
  readonly report: StatusReport;
  readonly schedule: readonly ScheduledRun[];
};

const domainsOf = (report: StatusReport): DomainView[] =>
  domainDeclarations.flatMap(({ kind, label, name }) => {
    const status = report.domains[name];
    return status === undefined
      ? []
      : [
          {
            kind,
            label,
            name,
            state: status.state,
            waitingFor: [...status.waitingFor],
          },
        ];
  });

const claimOf = (report: StatusReport): StatusView['claim'] => {
  const { claim } = report;
  if (claim === null) {
    return null;
  }
  const domain = claim.domain ?? 'unknown';
  return {
    domain,
    heartbeatAt: claim.heartbeatAt,
    label: isClaimDomain(domain) ? domainLabel(domain) : 'Unknown claim',
    stale: claim.stale,
    startedAt: claim.startedAt,
  };
};

const lastErrorOf = (report: StatusReport): StatusView['lastError'] => {
  const error = report.lastError;
  return error === null
    ? null
    : {
        at: error.at,
        blocking: error.blocking,
        code: error.code,
        domain: error.domain,
        message: error.message,
        retries: error.retries,
        revision: error.revision,
      };
};

export const statusView = ({
  keySources,
  report,
  schedule,
}: StatusInputs): StatusView => ({
  claim: claimOf(report),
  domains: domainsOf(report),
  historyIndex: { ...report.historyIndex },
  importState: report.importState,
  keySources: [...keySources],
  lastError: lastErrorOf(report),
  lastRun: { ...report.lastRun },
  revisions: {
    completed: report.revisions.completed,
    requested: report.revisions.requested,
    source: report.revisions.source,
  },
  schedule: [...schedule],
});
