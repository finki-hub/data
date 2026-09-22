import type { CountRow, PageRange } from '../page-state.js';
import type { HistoryIndexPort } from './history-port.js';
import type {
  ClaimDomain,
  Domain,
  OperationsState,
  PageSource,
  PublishedFile,
} from './state.js';

export type ClaimInsert = {
  readonly dirtyDomains: readonly Domain[];
  readonly domain: ClaimDomain;
  readonly fingerprint: string;
  readonly owner: string;
  readonly sourceRevision: number;
  readonly token: string;
};

// Everything the coordinator needs from storage, inside one transaction.
// Every writer returns whether its guard matched: a false means the claim
// is no longer the one the caller holds, and the caller must not proceed.
export type CoordinationPort = {
  // Guard: claim token and owner. Makes the claim's revision the current
  // source revision. Sound only under the singleton lock, right after a
  // statement of this run on a source table: nothing else can have moved
  // the revision in between, and the run's own rows cannot change its
  // output.
  readonly adoptOwnRevision: (token: string, owner: string) => Promise<boolean>;
  readonly candidateCount: (token: string) => Promise<number>;
  readonly currentFingerprint: () => Promise<string>;
  readonly discardCandidates: (token: string, page?: string) => Promise<number>;
  readonly ensureSingleton: () => Promise<void>;
  // Guard: claim token, owner, source revision and fingerprint unchanged.
  readonly finish: (input: FinishInput) => Promise<boolean>;
  // Guard: claim token and owner.
  readonly heartbeat: (token: string, owner: string) => Promise<boolean>;
  // The history index writes of the same transaction.
  readonly history: HistoryIndexPort;
  readonly insertCandidates: (input: StagedRows) => Promise<number>;
  // Replaces every course_enrollments row with the aggregated candidates
  // of the claim and returns how many rows were installed.
  readonly installEnrollments: (
    token: string,
    revision: number,
  ) => Promise<number>;
  readonly markDomains: (domains: readonly Domain[]) => Promise<MarkResult>;
  // With lock, the singleton row is locked until the transaction ends;
  // every transaction that writes reads it locked before anything else.
  readonly readState: (lock: boolean) => Promise<OperationsState>;
  // Guard: claim token, owner and source revision unchanged. Appends the
  // page to the staged list atomically and refreshes the heartbeat.
  readonly recordStagedPage: (
    token: string,
    owner: string,
    page: string,
  ) => Promise<boolean>;
  // Guard: claim token. Clears the claim and records the failure details.
  readonly release: (input: ReleaseInput) => Promise<boolean>;
  readonly sourceIds: (source: PageSource) => Promise<readonly number[]>;
  // Guard: claim token, owner and source revision unchanged.
  readonly storePlan: (
    token: string,
    owner: string,
    pages: readonly PageRange[],
  ) => Promise<boolean>;
  // Guard: no claim present and the source revision as read.
  readonly takeClaim: (input: ClaimInsert) => Promise<boolean>;
};

export type CoordinationStore = {
  readonly transaction: <T>(
    work: (port: CoordinationPort) => Promise<T>,
  ) => Promise<T>;
};

// Per-file publication outcomes as reported by the publication Flow; a
// missing or null entry records no outcome for that file.
export type FileOutcomes = Readonly<
  Partial<Record<PublishedFile, null | string | undefined>>
>;

export type FinishInput = {
  readonly dirtyDomains: readonly Domain[];
  readonly files: FileOutcomes | null;
  readonly fingerprint: string;
  readonly owner: string;
  readonly sourceRevision: number;
  readonly token: string;
};

export type MarkResult = {
  readonly dirtyDomains: readonly Domain[];
  readonly sourceRevision: number;
};

export type ReleaseInput = {
  readonly code: string;
  // True for a genuine failure (fail, abandoned); false when the run was
  // merely overtaken by a source or graph change and will simply rerun.
  readonly failed: boolean;
  readonly token: string;
};

export type StagedRows = {
  readonly page: string;
  readonly revision: number;
  readonly rows: readonly CountRow[];
  readonly token: string;
};
