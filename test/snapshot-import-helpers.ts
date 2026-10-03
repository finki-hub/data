import type {
  ExportedRow,
  FileFacts,
  SnapshotPort,
  SnapshotState,
  SnapshotStore,
  SnapshotTable,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/port.js';
import type { SnapshotDeps } from '../directus/extensions/directus-extension-data-operations/src/snapshot/stage.js';

import { csvLine } from '../directus/extensions/directus-extension-data-operations/src/snapshot/backup.js';
import {
  activeTable,
  snapshotFields,
  snapshotFolderId,
  type SnapshotRow,
  type SnapshotValue,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { fingerprintOf } from '../directus/extensions/directus-extension-data-operations/src/snapshot/fingerprint.js';
import { FakeCoordination } from './data-coordination-helpers.js';

export const owner = 'process-under-test';
export const csvFileId = '11111111-2222-4333-8444-555555555555';
export const otherFileId = '11111111-2222-4333-8444-666666666666';

// The refusals of the caller check, and the accountabilities it refuses.
const unauthenticated = {
  code: 'SNAPSHOT_UNAUTHENTICATED',
  message: 'Authentication required',
  status: 401,
};

export const forbiddenCaller = {
  code: 'SNAPSHOT_FORBIDDEN',
  message: 'Forbidden',
  status: 403,
};

export const refusedCallers = [
  [null, unauthenticated],
  [{ admin: true }, unauthenticated],
  [{ admin: 'true', user: 'u' }, unauthenticated],
  [{ admin: false, user: 'u' }, forbiddenCaller],
] as const;

type Row = { id: number; row: SnapshotRow };

type FakeSnapshotData = {
  active: Row[];
  staging: Row[];
  state: SnapshotState;
  uploads: Map<string, string>;
};

const freshState = (): SnapshotState => ({
  backupFile: null,
  backupFingerprint: null,
  backupRows: null,
  error: null,
  file: null,
  finishedAt: null,
  fingerprint: null,
  promoted: null,
  rows: null,
  startedAgeMs: null,
  startedAt: null,
  state: 'idle',
  token: null,
  warnings: null,
});

// A snapshot row with every field null except the given ones.
export const snapshotRow = (
  values: Readonly<
    Partial<Record<(typeof snapshotFields)[number], SnapshotValue>>
  >,
): SnapshotRow => snapshotFields.map((field) => values[field] ?? null);

export const syntheticRow = (index: number): SnapshotRow =>
  snapshotRow({
    Courses: `Synthetic Course ${index % 7}\nSynthetic Course ${(index + 3) % 7}`,
    'Courses Count': 2,
    ID_new: 10_000 + index,
    ID_old: index % 2 === 0 ? null : 5_000 + index,
    Name: `Synthetic User ${index}`,
  });

// A snapshot CSV with the header row in the contract order.
export const snapshotCsv = (rows: readonly SnapshotRow[]): string =>
  [csvLine(snapshotFields), ...rows.map((row) => csvLine(row))].join('');

type Hooks = {
  afterUpload?: (() => void) | undefined;
  corruptUpload?: ((text: string) => string) | undefined;
  // Runs before every export batch of the backup read.
  exportBatch?: (() => void) | undefined;
  replaceInserts?: ((staged: number) => number) | undefined;
  // What the database stores for a staged row (a silent alteration).
  stored?: ((row: SnapshotRow) => SnapshotRow) | undefined;
};

// The coordinator fake extended with the snapshot port: the two share one
// transaction, one lock and one rollback. The staging guard of the
// database is mirrored (a staging write before openStagingWriter fails),
// and replacing moodle_users fires the source trigger like the database.
export class FakeSnapshot {
  // Rows per staging insert, in order.
  public readonly batches: number[] = [];
  public readonly coordination = new FakeCoordination();
  public readonly files = new Map<
    string,
    { content: string[]; facts: FileFacts }
  >();
  public readonly hooks: Hooks = {};
  // What the operations logged: the details objects, in order.
  public readonly logs: Array<{ details: object; message: string }> = [];
  public readonly stateLog: string[] = [];
  public readonly store: SnapshotStore;
  #data: FakeSnapshotData = {
    active: [],
    staging: [],
    state: freshState(),
    uploads: new Map(),
  };
  #writer = false;

  public constructor() {
    this.store = {
      transaction: (work) =>
        this.coordination.store.transaction(async (coordination) => {
          const before = structuredClone(this.#data);
          this.#writer = false;
          try {
            return await work({ coordination, snapshot: this.#port() });
          } catch (error) {
            this.#data = before;
            throw error;
          }
        }),
    };
  }

  public get data(): FakeSnapshotData {
    return this.#data;
  }

  public addFile(id: string, content: string, facts: Partial<FileFacts> = {}) {
    this.files.set(id, {
      content: [content],
      facts: {
        filename: 'moodle-snapshot.csv',
        folder: snapshotFolderId,
        id,
        size: content.length,
        storage: 'local',
        type: 'text/csv',
        ...facts,
      },
    });
  }

  public deps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
    return {
      accountability: { admin: true, user: 'synthetic-admin' },
      claims: {
        owner,
        staleAfterMs: 60_000,
        store: this.coordination.store,
      },
      files: {
        describe: async (id) => this.files.get(id)?.facts ?? null,
        open: async (id) => {
          const file = this.files.get(id);
          const upload = this.#data.uploads.get(id);
          return (async function* () {
            yield* file?.content ?? (upload === undefined ? [] : [upload]);
          })();
        },
        upload: async (content, title) => {
          let text = '';
          try {
            for await (const chunk of content) {
              text += chunk;
            }
          } catch (error) {
            // Like FilesService: a failed source stream is a storage error.
            throw new Error(`Couldn't save file ${title}`, { cause: error });
          }
          const id = `backup-${this.#data.uploads.size + 1}-${title}`;
          this.#data.uploads.set(id, this.hooks.corruptUpload?.(text) ?? text);
          this.hooks.afterUpload?.();
          return id;
        },
      },
      heartbeat: async (token) =>
        this.coordination.heartbeatOutside(token, owner),
      limits: { heartbeatMs: 0, maxBytes: 1_000_000, timeoutMs: 60_000 },
      log: {
        warn: (details, message) => {
          this.logs.push({ details, message });
        },
      },
      markValidating: async (token) => {
        if (
          this.#data.state.token === token &&
          this.#data.state.state === 'importing'
        ) {
          this.#setState({ state: 'validating' });
        }
      },
      owner,
      store: this.store,
      ...overrides,
    };
  }

  public seedActive(rows: readonly SnapshotRow[]): void {
    this.#data.active = rows.map((row, index) => ({ id: index + 1, row }));
  }

  public setState(state: Partial<SnapshotState>): void {
    this.#setState(state);
  }

  #guard(): void {
    if (!this.#writer) {
      throw new Error(
        'moodle_import_rows is the staging of the controlled Moodle snapshot import',
      );
    }
  }

  #port(): SnapshotPort {
    const data = () => this.#data;
    const tableRows = (table: SnapshotTable) =>
      table === activeTable ? data().active : data().staging;
    return {
      beginImport: async ({ file, token }) => {
        this.#setState({
          error: null,
          file,
          fingerprint: null,
          rows: null,
          startedAgeMs: 0,
          state: 'importing',
          token,
          warnings: null,
        });
      },
      beginPromotion: async (token) => {
        this.#setState({ error: null, state: 'promoting', token });
      },
      boundStatements: async () => {},
      clearStaging: async () => {
        this.#guard();
        data().staging = [];
      },
      clock: async () => '20260922T120000Z',
      completePromotion: async ({
        claimToken,
        owner: claimOwner,
        promoted,
        token,
      }) => {
        const claim = this.coordination.data.claim;
        if (
          claim?.token !== claimToken ||
          claim.owner !== claimOwner ||
          claim.domain !== 'snapshot' ||
          data().state.token !== token ||
          data().state.state !== 'promoting'
        ) {
          return false;
        }
        this.coordination.data.claim = null;
        this.#setState({
          error: null,
          promoted: { ...promoted, at: '2026-09-22T12:00:00.000Z' },
          state: 'completed',
        });
        return true;
      },
      consistentRead: async () => {},
      exportBatch: async (afterId, limit): Promise<readonly ExportedRow[]> => {
        this.hooks.exportBatch?.();
        return data()
          .active.filter(({ id }) => id > afterId)
          .slice(0, limit);
      },
      failRun: async ({ error, token }) => {
        const { state } = data().state;
        if (
          data().state.token !== token ||
          !['importing', 'promoting', 'validating'].includes(state)
        ) {
          return false;
        }
        this.#setState({ error, state: 'failed' });
        return true;
      },
      finishImport: async ({ fingerprint, rows, token, warnings }) => {
        if (
          data().state.token !== token ||
          data().state.state !== 'validating'
        ) {
          return false;
        }
        this.#setState({ fingerprint, rows, state: 'ready', warnings });
        return true;
      },
      insertStaging: async (rows) => {
        this.#guard();
        this.batches.push(rows.length);
        for (const row of rows) {
          data().staging.push({
            id: data().staging.length + 1,
            row: this.hooks.stored?.(row) ?? row,
          });
        }
        return rows.length;
      },
      lockActive: async () => {},
      openStagingWriter: async () => {
        this.#writer = true;
      },
      read: async () => data().state,
      recordBackup: async ({ backup, token }) => {
        if (
          data().state.token !== token ||
          data().state.state !== 'promoting'
        ) {
          return false;
        }
        this.#setState({
          backupFile: backup.file,
          backupFingerprint: backup.fingerprint,
          backupRows: backup.rows,
        });
        return true;
      },
      replaceActive: async () => {
        const history = this.coordination.data.history;
        const memberships = history.memberships.length;
        history.memberships = [];
        const removed = data().active.length;
        this.coordination.sourceWrite('moodle_users', 'delete');
        const first =
          Math.max(
            0,
            ...data().active.map(({ id }) => id),
            this.#lastActiveId,
          ) + 1;
        const staged = data().staging.map(({ row }, index) => ({
          id: first + index,
          row,
        }));
        const inserted =
          this.hooks.replaceInserts?.(staged.length) ?? staged.length;
        data().active = staged.slice(0, inserted);
        this.#lastActiveId = first + staged.length - 1;
        this.coordination.sourceWrite('moodle_users', 'insert');
        return { inserted, memberships, removed };
      },
      summary: async (table) => {
        const rows = tableRows(table);
        return {
          fingerprint: fingerprintOf(rows.map(({ row }) => row)),
          rows: rows.length,
        };
      },
    };
  }

  #lastActiveId = 0;

  #setState(state: Partial<SnapshotState>): void {
    this.#data.state = { ...this.#data.state, ...state };
    if (state.state !== undefined) {
      this.stateLog.push(state.state);
    }
  }
}

export const readAll = async (
  source: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
): Promise<string> => {
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of source) {
    text +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
  }
  return text;
};

export const rowsOf = (rows: ReadonlyArray<{ readonly row: SnapshotRow }>) =>
  rows.map(({ row }) => row);
