import { keySources, optInField } from './exports/key-sources.js';
import {
  type Guard,
  guardStatements,
  keyDetail,
  refuse,
  text,
} from './row-guards.js';

// The key guards, derived from the key sources (exports/key-sources.ts):
// a row that stays published keeps its key text. Renaming a published
// program's or generation's code or a published year's label would drop
// its public keys and publish new ones although nobody set `published`,
// the per-row opt-in every new key needs; Studio even shows a program's
// code in the drawer of an entry's program states. Unpublishing the row
// first makes a rename deliberate: one write may unpublish and rename,
// and a rename of an unpublished row passes.

type KeyedTable = { readonly key: string; readonly table: string };

const optIn = (row: 'NEW' | 'OLD') => `${row}."${optInField}" IS TRUE`;

const keyGuard = ({ key, table }: KeyedTable): Guard => {
  const column = `"${key}"`;
  const message = `${table}.${key} cannot change while the row is published`;
  const previous = text(`OLD.${column}`);
  const detail = keyDetail(
    key,
    `NEW.${column}`,
    `') would replace the public key text ' || ${previous} || ' of published row ' || NEW."id" || '; unpublish it first.'`,
  );
  return {
    body: `IF ${optIn('OLD')} AND ${optIn('NEW')} AND NEW.${column} IS DISTINCT FROM OLD.${column} THEN
    ${refuse(table, message, detail)}
  END IF;`,
    declarations: '',
    events: `UPDATE OF ${column}`,
    name: `${table}_published_key_guard`,
    table,
  };
};

// One guard per key-source collection and key field.
export const keyGuards: readonly Guard[] = Array.from(
  new Map(
    Object.values(keySources).map(({ collection, key }) => [
      `${collection}.${key}`,
      { key, table: collection },
    ]),
  ).values(),
  (keyed) => keyGuard(keyed),
);

// Each guard's function, then its trigger; idempotent (CREATE OR REPLACE).
export const keyGuardStatements = (): readonly string[] =>
  guardStatements(keyGuards);
