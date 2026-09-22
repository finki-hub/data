import type {
  CoordinationPort,
  CoordinationStore,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/port.js';

import {
  type Domain,
  normaliseDomains,
  type OperationsState,
  type PageSource,
  type PublishedFile,
  sourceTableDeletionDomains,
  sourceTableDomains,
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
  domain: Domain;
  fingerprint: string;
  heartbeatAtMs: number;
  owner: string;
  pages: null | string[];
  ranges: PageRange[];
  revision: number;
  staged: string[];
  startedAtMs: number;
  token: string;
};

export type FakeCandidate = CountRow & {
  readonly page: string;
  readonly revision: number;
  readonly token: string;
};

export type FakeEnrollment = CountRow & { readonly revision: number };

export type FakeData = {
  calculationFingerprint: null | string;
  candidates: FakeCandidate[];
  claim: FakeClaim | null;
  completedRevision: number;
  dirtyDomains: Domain[];
  enrollments: FakeEnrollment[];
  finishedAtMs: null | number;
  history: FakeHistory;
  lastError: OperationsState['lastError'];
  publicationFingerprint: null | string;
  publicationState: string;
  publishedFiles: Record<PublishedFile, null | string>;
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
  lastError: null,
  publicationFingerprint: null,
  publicationState: 'idle',
  publishedFiles: { courses: null, rooms: null, staff: null, students: null },
  requestedRevision: 0,
  sourceRevision: 0,
  startedAtMs: null,
});

const stamp = (ms: null | number): null | string =>
  ms === null ? null : `t+${ms}`;

// An in-memory stand-in for the SQL port: the same guards, the same
// rollback on a thrown transaction, one transaction at a time, and a
// clock the test advances to age a heartbeat.
export class FakeCoordination {
  public fingerprint = 'graph-a';
  // The lock flag of every state read, in order, so a test can check that
  // a writing transaction locked the singleton before anything else.
  public readLocks: boolean[] = [];
  public sourceIds: Record<PageSource, number[]> = { history: [], rules: [] };
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

  // What the statement-level trigger does inside a source transaction; a
  // DELETE or TRUNCATE marks the deletion domains of the table as well.
  public sourceWrite(
    table: string,
    operation: 'delete' | 'insert' | 'update' = 'insert',
  ): void {
    const domains = [
      ...(sourceTableDomains[table] ?? []),
      ...(operation === 'delete'
        ? (sourceTableDeletionDomains[table] ?? [])
        : []),
    ];
    this.#data.sourceRevision += 1;
    this.#data.requestedRevision = this.#data.sourceRevision;
    this.#data.dirtyDomains = normaliseDomains([
      ...this.#data.dirtyDomains,
      ...domains,
    ]);
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
              revision: claim.revision,
              staged: claim.staged,
              startedAt: stamp(claim.startedAtMs) ?? '',
              token: claim.token,
            },
      completedRevision: data.completedRevision,
      dirtyDomains: data.dirtyDomains,
      finishedAt: stamp(data.finishedAtMs),
      importState: 'idle',
      lastError: data.lastError,
      publicationFingerprint: data.publicationFingerprint,
      publicationState: data.publicationState,
      publishedFiles: data.publishedFiles,
      requestedRevision: data.requestedRevision,
      sourceRevision: data.sourceRevision,
      startedAt: stamp(data.startedAtMs),
    };
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
    if (atRevision && claim.revision !== this.#data.sourceRevision) {
      return null;
    }
    return claim;
  }

  #port(): CoordinationPort {
    const data = () => this.#data;
    return {
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
      currentFingerprint: async () => this.fingerprint,
      discardCandidates: async (token, page) => {
        const before = data().candidates.length;
        data().candidates = data().candidates.filter(
          (row) =>
            row.token !== token || (page !== undefined && row.page !== page),
        );
        return before - data().candidates.length;
      },
      ensureSingleton: async () => {},
      finish: async (input) => {
        const claim = this.#liveClaim(input.token, input.owner, false);
        if (
          claim === null ||
          input.sourceRevision !== data().sourceRevision ||
          claim.fingerprint !== input.fingerprint
        ) {
          return false;
        }
        data().dirtyDomains = normaliseDomains(input.dirtyDomains);
        data().completedRevision = claim.revision;
        if (claim.domain === 'publication') {
          data().publicationFingerprint = claim.fingerprint;
          data().publicationState = 'completed';
          data().publishedFiles = {
            courses: input.files?.courses ?? null,
            rooms: input.files?.rooms ?? null,
            staff: input.files?.staff ?? null,
            students: input.files?.students ?? null,
          };
        } else {
          data().calculationFingerprint = claim.fingerprint;
        }
        data().startedAtMs = claim.startedAtMs;
        data().finishedAtMs = this.#now;
        data().claim = null;
        return true;
      },
      heartbeat: async (token, owner) => {
        const claim = this.#liveClaim(token, owner, false);
        if (claim === null) {
          return false;
        }
        claim.heartbeatAtMs = this.#now;
        return true;
      },
      history: fakeHistoryPort(
        () => data().history,
        () => {
          this.sourceWrite('moodle_course_entries');
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
      markDomains: async (domains) => {
        data().sourceRevision += 1;
        data().requestedRevision = data().sourceRevision;
        data().dirtyDomains = normaliseDomains([
          ...data().dirtyDomains,
          ...domains,
        ]);
        return {
          dirtyDomains: data().dirtyDomains,
          sourceRevision: data().sourceRevision,
        };
      },
      readState: async (lock) => {
        this.readLocks.push(lock);
        return this.#state();
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
        data().lastError = {
          at: stamp(this.#now),
          code: input.code,
          domain: claim.domain,
          fingerprint: claim.fingerprint,
          revision: claim.revision,
        };
        if (claim.domain === 'publication') {
          data().publicationState = input.failed ? 'failed' : 'idle';
        }
        data().claim = null;
        return true;
      },
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
