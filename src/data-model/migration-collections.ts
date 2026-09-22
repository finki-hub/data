import type { ModelCollection, ModelCollectionKey } from '../schema.js';

import { enumField, scalar } from './fields.js';

export const ledgerStatuses = ['running', 'completed', 'failed'] as const;

export type LedgerStatus = (typeof ledgerStatuses)[number];

// Private bookkeeping of the relational migration CLI: one row per migration
// version and step, keyed uniquely so two runs can never claim the same step
// and a resumed run skips what an earlier run completed. Written only by
// `npm run migrate -- --apply`; never a source table and never derived from
// one, so it carries no source-invalidation trigger.
export const migrationCollections: readonly ModelCollection[] = [
  {
    collection: 'migration_ledger',
    displayTemplate: '{{key}} ({{status}})',
    fields: [
      scalar('key', 'string', {
        note: 'Migration version and step, unique per claim.',
        nullable: false,
        readOnly: true,
        unique: true,
      }),
      scalar('version', 'string', { nullable: false, readOnly: true }),
      scalar('step', 'string', { nullable: false, readOnly: true }),
      enumField('status', ledgerStatuses, { nullable: false, readOnly: true }),
      scalar('source_fingerprint', 'string', {
        note: 'Fingerprint of the checkpoint rows and Flows the step was claimed against.',
        nullable: false,
        readOnly: true,
      }),
      scalar('run_token', 'string', {
        note: 'Token of the CLI run holding or having finished the step.',
        nullable: false,
        readOnly: true,
      }),
      scalar('id_map', 'json', {
        note: 'Source-to-target id map entries recorded by the step.',
        readOnly: true,
      }),
      scalar('started_at', 'timestamp', { nullable: false, readOnly: true }),
      scalar('finished_at', 'timestamp', { readOnly: true }),
      scalar('error', 'text', { readOnly: true }),
    ],
    hidden: true,
    icon: 'receipt_long',
    note: 'Private ledger of the relational migration: claimed, completed and failed steps per version. Written by the migrate CLI only.',
    origin: 'relational',
    singleton: false,
    sort: 25,
  },
];

export const migrationCollectionKeys: readonly ModelCollectionKey[] =
  migrationCollections.map(({ collection }) => collection);
