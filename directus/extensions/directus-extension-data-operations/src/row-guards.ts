// Row guards: BEFORE ... FOR EACH ROW triggers, each over its own plpgsql
// function, that refuse a write the Directus schema API cannot express
// (curriculum-guards.ts, key-guards.ts). A refusal is a
// foreign_key_violation whose DETAIL starts with `Key (<field>)=(<value>)`,
// which Directus answers as a 400 INVALID_FOREIGN_KEY naming the field.

export type Guard = {
  // The body between BEGIN and END; RETURN NEW follows it.
  readonly body: string;
  readonly declarations: string;
  // BEFORE ... ON <table> FOR EACH ROW.
  readonly events: string;
  readonly name: string;
  readonly table: string;
};

// A SQL expression as text, NULL spelled out.
export const text = (expression: string) =>
  `COALESCE(${expression}::text, 'NULL')`;

// A DETAIL that starts `Key (<field>)=(<value>)`, then the SQL `rest`.
export const keyDetail = (field: string, value: string, rest: string): string =>
  `'Key (${field})=(' || ${text(value)} || ${rest}`;

// The MESSAGE of a row guard: `<table>.<column> <state>`.
export const rowMessage = (
  table: string,
  column: string,
  state: string,
): string => `${table}.${column} ${state}`;

type FactPart = readonly [label: string, expression: string];

// One fact of a DETAIL as SQL: `<label> <value>` parts joined by spaces,
// each value a SQL expression as text.
export const fact = (...parts: readonly FactPart[]): string =>
  parts
    .map(([label, expression]) => `'${label} ' || ${text(expression)}`)
    .join(" || ' ' || ");

// The DETAIL of a row guard: `Key (<field>)=(<value>): <fact>, <fact>`.
export const keyFacts = (
  field: string,
  value: string,
  facts: readonly string[],
): string => keyDetail(field, value, `'): ' || ${facts.join(" || ', ' || ")}`);

export const refuse = (
  table: string,
  message: string,
  detail: string,
): string => `RAISE EXCEPTION '${message}'
      USING ERRCODE = 'foreign_key_violation', TABLE = '${table}',
        DETAIL = ${detail};`;

const functionName = (guard: Guard) => `finki_hub_${guard.name}`;

const functionSql = (guard: Guard) => `
CREATE OR REPLACE FUNCTION "${functionName(guard)}"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ${guard.declarations}
BEGIN
  ${guard.body}
  RETURN NEW;
END
$$`;

const triggerSql = (guard: Guard) =>
  `CREATE OR REPLACE TRIGGER "${guard.name}" BEFORE ${guard.events} ON "${guard.table}" FOR EACH ROW EXECUTE FUNCTION "${functionName(guard)}"()`;

// Each guard's function, then its trigger; idempotent (CREATE OR REPLACE).
export const guardStatements = (guards: readonly Guard[]): string[] =>
  guards.flatMap((guard) => [functionSql(guard), triggerSql(guard)]);
