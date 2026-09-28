import {
  type CollectionDeclaration,
  collectionDeclarations,
  isSource,
} from './coordination/collection-roles.js';
import {
  sourceTriggers,
  sqlComment,
  triggerFunction,
} from './coordination/invalidation-function.js';

// The source-invalidation migration, generated at module load from the
// collection-role registry and the declared domains; it takes no runtime
// input. source-invalidation.sql beside this file is its snapshot (npm run
// generate:invalidation), runnable with psql as well, and a unit test
// fails when the two differ.

const opening = `-- Source invalidation: the correctness boundary of the FINKI Hub data
-- operations. Every statement on an editable source table increments the
-- source revision and marks the affected domains inside the SAME
-- transaction as the edit, so a rolled-back edit marks nothing and a
-- committed edit becomes visible together with its mark. Nothing here
-- calculates, maps or dispatches a Flow. Derived, staging and status tables`;

const closing = `--
-- Invalidation is per table and marks whole domains: an UPDATE that moves
-- a mapping or a rule to another course or year, and any DELETE, marks
-- the domain, whose next run recomputes every pair, so the old and the new
-- relationship are both covered. The history index and the enrollment
-- counts also keep the revision of the last statement that touched their
-- inputs (history_index_input_revision, enrollments_input_revision): a
-- running calculation is overtaken only by such a statement.
--
-- Applied by the bundled migration runner of the data-operations extension
-- (POST /finki-hub-data-operations/migrations/source-invalidation) after the
-- data model is installed. Statements are separated by a line holding a
-- single semicolon and each runs as its own raw() call inside one
-- transaction. Everything is idempotent.
--
-- The data_operations singleton row must exist: the trigger refuses a
-- source write it cannot record. The first statement creates the row when
-- it is missing and the second keeps the table at exactly one row.
`;

const singletonRow = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "data_operations") THEN
    INSERT INTO "data_operations" DEFAULT VALUES;
  END IF;
END
$$`;

const singletonIndex =
  'CREATE UNIQUE INDEX IF NOT EXISTS "data_operations_singleton_unique" ON "data_operations" ((true))';

// The derived, candidate, staging and status tables the header names.
const header = (declarations: readonly CollectionDeclaration[]): string => {
  const unmarked = declarations
    .filter(({ role }) => role !== 'source')
    .map(({ collection }) => collection);
  return [
    opening,
    ...sqlComment(
      `(${[...unmarked, 'directus_*'].join(', ')}) carry no trigger.`,
      '',
    ),
    closing,
  ].join('\n');
};

// The migration text for a registry: the header, the singleton row and
// index, the trigger function and the triggers of every source, each
// statement followed by a line holding a semicolon.
export const invalidationSql = (
  declarations: readonly CollectionDeclaration[],
): string => {
  const sources = declarations.filter(isSource);
  const statements = [
    singletonRow,
    singletonIndex,
    triggerFunction(sources),
    ...sources.flatMap((source) => sourceTriggers(source)),
  ];
  const body = statements.map((statement) => `${statement}\n;\n`).join('');
  return `${header(declarations)}\n${body}`;
};

export const sourceInvalidationSql = invalidationSql(collectionDeclarations);

// Statements are separated by a line holding a single semicolon; full-line
// comments are dropped so every statement starts with SQL.
export const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text !== '') {
      statements.push(text);
    }
    current = [];
  };
  for (const line of sql.split('\n')) {
    if (line.trim() === ';') {
      flush();
    } else if (!line.trimStart().startsWith('--')) {
      current.push(line);
    }
  }
  flush();
  return statements;
};
