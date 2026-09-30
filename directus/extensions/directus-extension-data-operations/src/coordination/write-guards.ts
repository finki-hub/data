import {
  declarationOf,
  type GuardedCollection,
  type GuardedDeclaration,
  guardedDeclarations,
  isGuarded,
} from './collection-roles.js';

// The database write guard of every derived, candidate and staging table
// of the collection-role registry: one statement trigger per table on one
// shared function, installed by the schema-constraints migration. Only the
// table's own writer, which opens the guard for its transaction, and a
// foreign key cascade (it runs inside the cascade trigger, depth 2) pass.
// Studio, REST, Flows and raw SQL are refused; the Directus hooks of
// write-guard.ts refuse item writes with the same message first.

const guardFunction = 'finki_hub_write_guard';

const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

// The transaction-local setting a writer turns on for its own transaction.
export const writerSetting = ({ guard }: GuardedDeclaration): string =>
  `finki_hub.${guard.writer}`;

// Why a write outside the writer is refused:
// `Write refused: <collection> (<role>; writer: <writer>)`.
export const guardMessage = ({
  collection,
  guard,
  role,
}: GuardedDeclaration): string =>
  `Write refused: ${collection} (${role}; writer: ${guard.writtenBy})`;

const guarded = (collection: GuardedCollection): GuardedDeclaration => {
  const declaration = declarationOf(collection);
  if (declaration === undefined || !isGuarded(declaration)) {
    throw new Error(`${collection} declares no write guard`);
  }
  return declaration;
};

// Transaction-local: the setting ends with the writer's transaction, so a
// pooled connection never carries it into another statement.
export const openGuardStatement = (declaration: GuardedDeclaration): string =>
  `SELECT set_config(${literal(writerSetting(declaration))}, 'on', true)`;

export const openGuardSql = (collection: GuardedCollection): string =>
  openGuardStatement(guarded(collection));

const functionSql = `CREATE OR REPLACE FUNCTION "${guardFunction}"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 AND current_setting(TG_ARGV[0], true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING MESSAGE = TG_ARGV[1], ERRCODE = 'insufficient_privilege',
      TABLE = TG_TABLE_NAME, HINT = TG_ARGV[2];
  END IF;
  RETURN NULL;
END
$$`;

const writeGuardTriggerSql = (declaration: GuardedDeclaration): string =>
  `CREATE OR REPLACE TRIGGER "${declaration.collection}_write_guard" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${declaration.collection}" FOR EACH STATEMENT EXECUTE FUNCTION "${guardFunction}"(${[
    writerSetting(declaration),
    guardMessage(declaration),
    declaration.guard.hint,
  ]
    .map(literal)
    .join(', ')})`;

// The shared function, then one trigger per guarded table.
export const writeGuardStatements = (
  declarations: readonly GuardedDeclaration[] = guardedDeclarations,
): readonly string[] => [
  functionSql,
  ...declarations.map(writeGuardTriggerSql),
];
