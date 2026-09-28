import type { ImportState } from '../coordination/domains.js';
import type { CoordinationPort } from '../coordination/port.js';
import type { activeTable, SnapshotRow, stagingTable } from './contract.js';

export type BackupRecord = SnapshotSummary & { readonly file: string };

export type ExportedRow = {
  readonly id: number;
  readonly row: SnapshotRow;
};

// The private CSV as directus_files describes it.
export type FileFacts = {
  readonly filename: null | string;
  readonly folder: null | string;
  readonly id: string;
  readonly size: null | number;
  readonly storage: string;
  readonly type: null | string;
};

export type SnapshotFiles = {
  readonly describe: (id: string) => Promise<FileFacts | null>;
  readonly open: (id: string) => Promise<AsyncIterable<string | Uint8Array>>;
  // Stores a new private file in the local storage location.
  readonly upload: (
    content: AsyncIterable<string>,
    title: string,
  ) => Promise<string>;
};

// Every snapshot write, inside one transaction of the store. Guarded
// writers return whether their guard (the run's token and state) matched.
export type SnapshotPort = {
  readonly beginImport: (input: {
    readonly file: string;
    readonly token: string;
  }) => Promise<void>;
  readonly beginPromotion: (token: string) => Promise<void>;
  readonly boundStatements: (milliseconds: number) => Promise<void>;
  readonly clearStaging: () => Promise<void>;
  readonly clock: () => Promise<string>;
  readonly completePromotion: (input: {
    readonly claimToken: string;
    readonly owner: string;
    readonly promoted: SnapshotSummary;
    readonly token: string;
  }) => Promise<boolean>;
  // Must be the first statement of its transaction.
  readonly consistentRead: () => Promise<void>;
  readonly exportBatch: (
    afterId: number,
    limit: number,
  ) => Promise<readonly ExportedRow[]>;
  readonly failRun: (input: {
    readonly error: string;
    readonly token: string;
  }) => Promise<boolean>;
  readonly finishImport: (input: {
    readonly fingerprint: string;
    readonly rows: number;
    readonly token: string;
    readonly warnings: null | string;
  }) => Promise<boolean>;
  readonly insertStaging: (rows: readonly SnapshotRow[]) => Promise<number>;
  // LOCK TABLE moodle_users IN EXCLUSIVE MODE.
  readonly lockActive: () => Promise<void>;
  readonly openStagingWriter: () => Promise<void>;
  readonly read: () => Promise<SnapshotState>;
  readonly recordBackup: (input: {
    readonly backup: BackupRecord;
    readonly token: string;
  }) => Promise<boolean>;
  // Deletes every history membership (the history writer guard opened for
  // this transaction) and every active Moodle user, then inserts the
  // staged rows in staging order.
  readonly replaceActive: () => Promise<Replacement>;
  readonly summary: (table: SnapshotTable) => Promise<SnapshotSummary>;
};

export type SnapshotPorts = {
  readonly coordination: CoordinationPort;
  readonly snapshot: SnapshotPort;
};

// The snapshot columns of the data_operations singleton.
export type SnapshotState = {
  readonly backupFile: null | string;
  readonly backupFingerprint: null | string;
  readonly backupRows: null | number;
  readonly error: null | string;
  readonly file: null | string;
  readonly fingerprint: null | string;
  readonly finishedAt: null | string;
  // The snapshot the last completed promotion made active.
  readonly promoted: null | PromotedSnapshot;
  readonly rows: null | number;
  readonly startedAgeMs: null | number;
  readonly startedAt: null | string;
  readonly state: ImportState;
  readonly token: null | string;
  readonly warnings: null | string;
};

export type SnapshotStore = {
  readonly transaction: <T>(
    work: (ports: SnapshotPorts) => Promise<T>,
  ) => Promise<T>;
};

export type SnapshotSummary = {
  readonly fingerprint: string;
  readonly rows: number;
};

export type SnapshotTable = typeof activeTable | typeof stagingTable;

type PromotedSnapshot = SnapshotSummary & { readonly at: null | string };

type Replacement = {
  readonly inserted: number;
  readonly memberships: number;
  readonly removed: number;
};
