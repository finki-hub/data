import type { Fingerprints } from '../directus/extensions/directus-extension-data-operations/src/coordination/fingerprint.js';
import type {
  CoordinationPort,
  CoordinationStore,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/port.js';
import type { EnrollmentSources } from '../directus/extensions/directus-extension-data-operations/src/enrollment-pages.js';

import { sourceDeclarations } from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import {
  type CalculationDomain,
  type ClaimDomain,
  type Domain,
  normaliseDomains,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  abandonmentCode,
  inputRevision,
  touchesInputs,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/failures.js';
import {
  releasedPublicationState,
  type StoredOutcomes,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import {
  type OperationsState,
  type PageSource,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import {
  type CountRow,
  type PageRange,
  stagedWith,
} from '../directus/extensions/directus-extension-data-operations/src/page-state.js';
import {
  type FakeHistory,
  fakeHistoryPort,
  freshHistory,
} from './history-index-helpers.js';

type FakeClaim = {
  domain: ClaimDomain;
  fingerprint: string;
  heartbeatAtMs: number;
  owner: string;
  pages: null | string[];
  ranges: PageRange[];
  retries: number;
  revision: number;
  staged: string[];
  startedAtMs: number;
  token: string;
};

type FakeCandidate = CountRow & {
  readonly page: string;
  readonly revision: number;
  readonly token: string;
};

type FakeEnrollment = CountRow & { readonly revision: number };

type FakeData = {
  calculationFingerprint: null | string;
  candidates: FakeCandidate[];
  claim: FakeClaim | null;
  completedRevision: number;
  dirtyDomains: Domain[];
  enrollments: FakeEnrollment[];
  finishedAtMs: null | number;
  history: FakeHistory;
  inputRevisions: Record<CalculationDomain, number>;
  lastError: OperationsState['lastError'];
  lastRunRetries: number;
  publicationFingerprint: null | string;
  publicationOutcomes: null | StoredOutcomes;
  publicationState: string;
  requestedRevision: number;
  sourceRevision: number;
  startedAtMs: null | number;
};

const freshData = (): FakeData => ({
  calculationFingerprint: null,
  candidates: [],
  claim: null,
  completedRevision: 0,
  dirtyDomains: [],
  enrollments: [],
  finishedAtMs: null,
  history: freshHistory(),
  inputRevisions: { enrollments: 0, history_index: 0 },
  lastError: null,
  lastRunRetries: 0,
  publicationFingerprint: null,
  publicationOutcomes: null,
  publicationState: 'idle',
  requestedRevision: 0,
  sourceRevision: 0,
  startedAtMs: null,
});

const stamp = (ms: null | number): null | string =>
  ms === null ? null : `t+${ms}`;

// An in-memory stand-in for the SQL port: the same guards, the same
// rollback on a thrown transaction, one transaction at a time, and a
// clock the test advances to age a heartbeat.
// The same fingerprint for both graphs, as a test that changes a
// calculation step sees them (a publication-only change moves only the
// publication fingerprint).
export const bothGraphs = (fingerprint: string): Fingerprints => ({
  calculation: fingerprint,
  publication: fingerprint,
});

export class FakeCoordination {
  // The current fingerprint of each graph.
  public graphs: Fingerprints = bothGraphs('graph-a');
  // The lock flag of every state read, in order, so a test can check that
  // a writing transaction locked the singleton before anything else.
  public readLocks: boolean[] = [];
  public sourceIds: Record<PageSource, number[]> = { history: [], rules: [] };
  // What plan_pages with source enrollments reads: rule modes and pattern
  // bytes (also what a rules plan checks) and history byte sizes.
  public enrollmentSources: EnrollmentSources = { rules: [], users: [] };
  // Every bounded lock wait a transaction asked for, in order.
  public lockWaits: number[] = [];
  public transactions = 0;
  public readonly store: CoordinationStore;

  #data: FakeData = freshData();
  #lock: Promise<void> = Promise.resolve();
  #now = 1_000_000;

  public constructor() {
    this.store = { transaction: (work) => this.#transaction(work) };
  }

  public get data(): FakeData {
    return this.#data;
  }

  public advance(ms: number): void {
    this.#now += ms;
  }

  // What another connection does while a transaction of this process is
  // open (the fake serialises its transactions, the database does not): a
  // heartbeat of the claim, and the recovery of a stale claim.
  public heartbeatOutside(token: string, owner: string): boolean {
    const claim = this.#liveClaim(token, owner, false);
    if (claim === null) {
      return false;
    }
    claim.heartbeatAtMs = this.#now;
    return true;
  }

  public recoverOutside(staleAfterMs: number): boolean {
    const claim = this.#data.claim;
    const state = this.#state();
    if (
      claim === null ||
      state.claim === null ||
      this.#now - claim.heartbeatAtMs <= staleAfterMs
    ) {
      return false;
    }
    this.#release(claim, {
      code: abandonmentCode(state, state.claim),
      failed: true,
      message: null,
    });
    return true;
  }

  // What the statement-level triggers generated from the collection-role
  // registry do inside a source transaction; a DELETE or TRUNCATE marks the
  // deletion domains of the table as well, and an UPDATE naming a refined
  // column (an entry label) its domains. A table that is no registered
  // source carries no trigger, so writing it here is a test bug.
  public sourceWrite(
    table: string,
    operation: 'delete' | 'insert' | 'update' = 'insert',
    columns: readonly string[] = [],
  ): void {
    const source = sourceDeclarations.find(
      ({ collection }) => collection === table,
    );
    if (source === undefined) {
      throw new Error(`${table} is no registered source table`);
    }
    const refined = source.columns ?? {};
    this.#mark([
      ...source.invalidates,
      ...(operation === 'delete' ? (source.onDelete ?? []) : []),
      ...(operation === 'update'
        ? columns.flatMap((column) => refined[column]?.domains ?? [])
        : []),
    ]);
  }

  // What the trigger function and markSql both write: the next source
  // revision, the input revision of every calculation the domains touch,
  // and the union of the dirty domains.
  #mark(domains: readonly Domain[]): void {
    const data = this.#data;
    data.sourceRevision += 1;
    data.requestedRevision = data.sourceRevision;
    for (const calculation of ['history_index', 'enrollments'] as const) {
      if (touchesInputs(domains, calculation)) {
        data.inputRevisions[calculation] = data.sourceRevision;
      }
    }
    data.dirtyDomains = normaliseDomains([...data.dirtyDomains, ...domains]);
  }

  async #transaction<T>(
    work: (port: CoordinationPort) => Promise<T>,
  ): Promise<T> {
    const previous = this.#lock;
    const gate = Promise.withResolvers<undefined>();
    this.#lock = gate.promise;
    await previous;
    this.transactions += 1;
    const snapshot = structuredClone(this.#data);
    try {
      return await work(this.#port());
    } catch (error) {
      this.#data = snapshot;
      throw error;
    } finally {
      gate.resolve(undefined);
    }
  }

  #state(): OperationsState {
    const data = this.#data;
    const claim = data.claim;
    return {
      calculationFingerprint: data.calculationFingerprint,
      claim:
        claim === null
          ? null
          : {
              domain: claim.domain,
              fingerprint: claim.fingerprint,
              heartbeatAgeMs: this.#now - claim.heartbeatAtMs,
              heartbeatAt: stamp(claim.heartbeatAtMs) ?? '',
              owner: claim.owner,
              pages: claim.pages,
              ranges: claim.ranges,
              retries: claim.retries,
              revision: claim.revision,
              staged: claim.staged,
              startedAt: stamp(claim.startedAtMs) ?? '',
              token: claim.token,
            },
      completedRevision: data.completedRevision,
      dirtyDomains: data.dirtyDomains,
      finishedAt: stamp(data.finishedAtMs),
      importState: 'idle',
      inputRevisions: { ...data.inputRevisions },
      lastError: data.lastError,
      lastRunRetries: data.lastRunRetries,
      publicationFingerprint: data.publicationFingerprint,
      publicationOutcomes: data.publicationOutcomes,
      publicationState: data.publicationState,
      requestedRevision: data.requestedRevision,
      sourceRevision: data.sourceRevision,
      startedAt: stamp(data.startedAtMs),
    };
  }

  // releaseSql: the failure columns keep a work domain's failure when a
  // snapshot promotion's claim is released.
  #release(
    claim: FakeClaim,
    input: {
      readonly code: string;
      readonly failed: boolean;
      readonly files?: null | StoredOutcomes;
      readonly message?: null | string;
    },
  ): void {
    if (claim.domain !== 'snapshot') {
      this.#data.lastError = {
        at: stamp(this.#now),
        code: input.code,
        domain: claim.domain,
        fingerprint: claim.fingerprint,
        message: input.message ?? null,
        retries: claim.retries,
        revision: claim.revision,
      };
    }
    if (claim.domain === 'publication') {
      this.#data.publicationOutcomes =
        input.files ?? this.#data.publicationOutcomes;
      this.#data.publicationState = releasedPublicationState(
        input.failed,
        this.#data.publicationOutcomes,
        claim.revision,
      );
    }
    this.#data.claim = null;
  }

  // The guard every writer of a live claim applies.
  #liveClaim(
    token: string,
    owner: string,
    atRevision: boolean,
  ): FakeClaim | null {
    const claim = this.#data.claim;
    if (claim?.token !== token || claim.owner !== owner) {
      return null;
    }
    if (
      atRevision &&
      inputRevision(this.#state(), claim.domain) > claim.revision
    ) {
      return null;
    }
    return claim;
  }

  #port(): CoordinationPort {
    const data = () => this.#data;
    return {
      addRetries: async (token, owner, retries) => {
        const claim = this.#liveClaim(token, owner, false);
        if (claim === null) {
          return false;
        }
        claim.retries += retries;
        return true;
      },
      adoptOwnRevision: async (token, owner) => {
        const claim = this.#liveClaim(token, owner, false);
        if (claim === null) {
          return false;
        }
        claim.revision = data().sourceRevision;
        return true;
      },
      candidateCount: async (token) =>
        data().candidates.filter((row) => row.token === token).length,
      currentFingerprints: async () => this.graphs,
      discardCandidates: async (token, page) => {
        const before = data().candidates.length;
        data().candidates = data().candidates.filter(
          (row) =>
            row.token !== token || (page !== undefined && row.page !== page),
        );
        return before - data().candidates.length;
      },
      enrollmentSources: async () => this.enrollmentSources,
      ensureSingleton: async () => {},
      finish: async (input) => {
        const superseded =
          input.superseded && data().claim?.domain === 'publication';
        const claim = this.#liveClaim(input.token, input.owner, !superseded);
        if (
          claim?.revision !== input.claimRevision ||
          claim.fingerprint !== input.fingerprint
        ) {
          return false;
        }
        data().dirtyDomains = normaliseDomains(input.dirtyDomains);
        data().completedRevision = claim.revision;
        if (claim.domain === 'publication') {
          data().publicationFingerprint = claim.fingerprint;
          data().publicationState = 'completed';
          data().publicationOutcomes = input.files;
        } else {
          data().calculationFingerprint = claim.fingerprint;
        }
        data().lastRunRetries = claim.retries;
        data().startedAtMs = claim.startedAtMs;
        data().finishedAtMs = this.#now;
        data().claim = null;
        return true;
      },
      heartbeat: async (token, owner, leaseMs = 0) => {
        const claim = this.#liveClaim(token, owner, false);
        if (claim === null) {
          return false;
        }
        claim.heartbeatAtMs = this.#now + leaseMs;
        return true;
      },
      history: fakeHistoryPort(
        () => data().history,
        {
          now: () => stamp(this.#now),
          onEntryStatement: () => {
            this.sourceWrite('moodle_course_entries');
          },
        },
        () => this.sourceIds.history,
      ),
      insertCandidates: async (input) => {
        for (const row of input.rows) {
          const clash = data().candidates.some(
            (existing) =>
              existing.token === input.token &&
              existing.page === input.page &&
              existing.course === row.course &&
              existing.academic_year === row.academic_year,
          );
          if (clash) {
            throw new Error('duplicate key value violates unique constraint');
          }
          data().candidates.push({
            ...row,
            page: input.page,
            revision: input.revision,
            token: input.token,
          });
        }
        return input.rows.length;
      },
      installEnrollments: async (token, revision) => {
        const totals = new Map<string, FakeEnrollment>();
        for (const row of data().candidates) {
          if (row.token !== token) {
            continue;
          }
          const key = `${row.course}/${row.academic_year}`;
          const existing = totals.get(key);
          totals.set(key, {
            academic_year: row.academic_year,
            count: (existing?.count ?? 0) + row.count,
            course: row.course,
            revision,
          });
        }
        data().enrollments = totals.values().toArray();
        return data().enrollments.length;
      },
      limitLockWait: async (ms) => {
        this.lockWaits.push(ms);
      },
      markDomains: async (domains) => {
        this.#mark(domains);
        return {
          dirtyDomains: data().dirtyDomains,
          sourceRevision: data().sourceRevision,
        };
      },
      readState: async (lock) => {
        this.readLocks.push(lock);
        return this.#state();
      },
      recordOutcomes: async (token, owner, files) => {
        const claim = this.#liveClaim(token, owner, false);
        if (claim?.domain !== 'publication') {
          return false;
        }
        data().publicationOutcomes = files;
        claim.heartbeatAtMs = this.#now;
        return true;
      },
      recordStagedPage: async (token, owner, page) => {
        const claim = this.#liveClaim(token, owner, true);
        if (claim === null) {
          return false;
        }
        claim.staged = stagedWith(claim.staged, page);
        claim.heartbeatAtMs = this.#now;
        return true;
      },
      release: async (input) => {
        const claim = data().claim;
        if (claim?.token !== input.token) {
          return false;
        }
        this.#release(claim, input);
        return true;
      },
      ruleModes: async () => this.enrollmentSources.rules,
      sourceIds: async (source) => this.sourceIds[source],
      storePlan: async (token, owner, pages) => {
        const claim = this.#liveClaim(token, owner, true);
        if (claim === null) {
          return false;
        }
        claim.pages = pages.map((page) => page.token);
        claim.ranges = [...pages];
        claim.staged = [];
        claim.heartbeatAtMs = this.#now;
        return true;
      },
      takeClaim: async (input) => {
        if (
          data().claim !== null ||
          data().sourceRevision !== input.sourceRevision
        ) {
          return false;
        }
        data().claim = {
          domain: input.domain,
          fingerprint: input.fingerprint,
          heartbeatAtMs: this.#now,
          owner: input.owner,
          pages: null,
          ranges: [],
          retries: 0,
          revision: input.sourceRevision,
          staged: [],
          startedAtMs: this.#now,
          token: input.token,
        };
        data().dirtyDomains = normaliseDomains(input.dirtyDomains);
        if (input.domain === 'publication') {
          data().publicationState = 'running';
        }
        return true;
      },
    };
  }
}
