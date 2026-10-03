import type { DomainStatus, StatusReport } from './coordination/status.js';

import {
  domainDeclarations,
  domainLabel,
  isClaimDomain,
} from './coordination/domains.js';
import {
  declaredFilenames,
  type StoredOutcomes,
} from './coordination/outcomes.js';
import {
  type DomainView,
  type FileView,
  type KeySourceView,
  type StatusView,
} from './status-contract.js';

// The data status as the dashboard shows it, built from the bounded
// coordinator status: every declared domain in dependency order, every
// declared file with its last outcome, the key-source rows and the last
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
  // The published files the export definitions declare, in order.
  readonly declared?: readonly string[];
  readonly keySources: readonly KeySourceView[];
  readonly report: StatusReport;
  readonly schedule: readonly ScheduledRun[];
};

// A failed publication that uploaded some declared files reads partial,
// as its files do; every other state is the coordinator's.
const viewState = (
  kind: DomainView['kind'],
  state: DomainStatus['state'],
  publication: string,
): DomainView['state'] =>
  kind === 'publication' && state === 'failed' && publication === 'partial'
    ? 'partial'
    : state;

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
            state: viewState(kind, status.state, report.publication.state),
            waitingFor: [...status.waitingFor],
          },
        ];
  });

// Every declared file first, in publication order, then any outcome a
// retired definition left behind.
const filesOf = (
  stored: null | StoredOutcomes,
  declared: readonly string[],
): FileView[] => {
  const outcomes = stored ?? {};
  const names = [
    ...declared,
    ...Object.keys(outcomes).filter((filename) => !declared.includes(filename)),
  ];
  return names.map((filename) => {
    const entry = outcomes[filename];
    return {
      bytes: entry?.bytes ?? null,
      code: entry?.code ?? null,
      filename,
      outcome: entry?.outcome ?? null,
      revision: entry?.revision ?? null,
    };
  });
};

// The revision of the last publication, read from its outcome entries
// (every entry carries the revision of the claim that attempted it), and
// whether every declared file was uploaded at it.
const lastPublication = (
  files: readonly FileView[],
  declared: readonly string[],
): { readonly complete: boolean; readonly lastRevision: null | number } => {
  const revisions = files.flatMap(({ revision }) =>
    revision === null ? [] : [revision],
  );
  const lastRevision = revisions.length === 0 ? null : Math.max(...revisions);
  const complete =
    lastRevision !== null &&
    declared.length > 0 &&
    declared.every((filename) =>
      files.some(
        (file) =>
          file.filename === filename &&
          file.outcome === 'uploaded' &&
          file.revision === lastRevision,
      ),
    );
  return { complete, lastRevision };
};

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
  declared = declaredFilenames,
  keySources,
  report,
  schedule,
}: StatusInputs): StatusView => {
  const files = filesOf(report.publication.files, declared);
  return {
    claim: claimOf(report),
    domains: domainsOf(report),
    historyIndex: { ...report.historyIndex },
    importState: report.importState,
    keySources: [...keySources],
    lastError: lastErrorOf(report),
    lastRun: { ...report.lastRun },
    publication: {
      ...lastPublication(files, declared),
      files,
      state: report.publication.state,
    },
    revisions: {
      completed: report.revisions.completed,
      requested: report.revisions.requested,
      source: report.revisions.source,
    },
    schedule: [...schedule],
  };
};
