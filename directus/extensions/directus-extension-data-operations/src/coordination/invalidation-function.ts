import type { SourceDeclaration } from './collection-roles.js';

import {
  calculationDomains,
  coordinationDomains,
  type Domain,
  domainDeclarations,
} from './domains.js';

// The trigger function and the statement triggers of the
// source-invalidation migration, generated from the source declarations
// of the collection-role registry and the declared domains.

const invalidation = 'finki_hub_source_invalidation';
const commentWidth = 76;

// What every source marks when the trigger function lists no arm for it.
const defaultDomains: readonly Domain[] = domainDeclarations
  .filter(({ kind }) => kind === 'publication')
  .map(({ name }) => name);

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

// A text array literal. An empty one would have no type: PostgreSQL plans
// the trigger function only at the first statement on a source and would
// fail that statement, so the generator refuses it instead.
export const sqlArray = (values: readonly string[]): string => {
  if (values.length === 0) {
    throw new Error(
      'An empty domain list would generate an untyped ARRAY[]; declare at least one domain.',
    );
  }
  return `ARRAY[${quoted(values)}]`;
};

const sameDomains = (left: readonly Domain[], right: readonly Domain[]) =>
  left.length === right.length &&
  left.every((domain, index) => right[index] === domain);

// Prose as full-line SQL comments, wrapped greedily at the comment width.
export const sqlComment = (text: string, indent: string): string[] => {
  const prefix = `${indent}-- `;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const longer = line === '' ? word : `${line} ${word}`;
    if (line !== '' && prefix.length + longer.length > commentWidth) {
      lines.push(`${prefix}${line}`);
      line = word;
    } else {
      line = longer;
    }
  }
  return [...lines, `${prefix}${line}`];
};

const arms = (sources: readonly SourceDeclaration[]): string[] => {
  const listed = sources.filter(
    ({ invalidates }) => !sameDomains(invalidates, defaultDomains),
  );
  return [
    ...listed.filter(({ caseLast }) => caseLast !== true),
    ...listed.filter(({ caseLast }) => caseLast === true),
  ].map(
    ({ collection, invalidates }) =>
      `    WHEN '${collection}' THEN ${sqlArray(invalidates)}`,
  );
};

// A DELETE or TRUNCATE, or an UPDATE through a column trigger, adds its
// domains; conditions that add the same domains share one IF.
const refinements = (source: SourceDeclaration): string[] => {
  const conditions = new Map<string, string[]>();
  const add = (domains: readonly Domain[], condition: string): void => {
    const key = sqlArray(domains);
    conditions.set(key, [...(conditions.get(key) ?? []), condition]);
  };
  if (source.onDelete !== undefined) {
    add(source.onDelete, "TG_OP IN ('DELETE', 'TRUNCATE')");
  }
  const columns = Object.values(source.columns ?? {});
  for (const { domains, trigger } of columns) {
    add(domains, `TG_NAME = '${trigger}'`);
  }
  if (conditions.size === 0) {
    return [];
  }
  return [
    ...sqlComment(source.why ?? '', '  '),
    ...[...conditions].flatMap(([domains, alternatives]) => [
      `  IF TG_TABLE_NAME = '${source.collection}' AND (${alternatives.join(' OR ')}) THEN`,
      `    affected := affected || ${domains};`,
      '  END IF;',
    ]),
  ];
};

// Each calculation's input revision moves with its own domain and every
// upstream one (touchesInputs applies the same rule to a mark).
const inputRevisions = calculationDomains.map((domain) => {
  const upstream = coordinationDomains.slice(
    0,
    coordinationDomains.indexOf(domain) + 1,
  );
  return `    "${domain}_input_revision" = CASE WHEN affected && ${sqlArray(upstream)} THEN "source_revision" + 1 ELSE "${domain}_input_revision" END,`;
});

export const triggerFunction = (
  sources: readonly SourceDeclaration[],
): string =>
  [
    `CREATE OR REPLACE FUNCTION "${invalidation}"() RETURNS trigger`,
    'LANGUAGE plpgsql AS $$',
    'DECLARE',
    '  affected text[];',
    'BEGIN',
    '  affected := CASE TG_TABLE_NAME',
    ...arms(sources),
    `    ELSE ${sqlArray(defaultDomains)}`,
    '  END;',
    ...sources.flatMap(refinements),
    "  -- A calculation's input revision moves with every statement that marks",
    '  -- it or an upstream domain, so a run of it is overtaken (and a failure',
    '  -- of it lifted) by those statements only, never by a publication-only',
    '  -- edit; publication follows the source revision itself.',
    '  UPDATE "data_operations" SET',
    '    "source_revision" = "source_revision" + 1,',
    '    "requested_revision" = "source_revision" + 1,',
    ...inputRevisions,
    '    "dirty_domains" = (',
    "      SELECT COALESCE(json_agg(domain ORDER BY position), '[]'::json)",
    `      FROM unnest(${sqlArray(coordinationDomains)}) WITH ORDINALITY AS known(domain, position)`,
    '      WHERE domain = ANY(affected)',
    '        OR EXISTS (',
    '          SELECT 1',
    '          FROM json_array_elements_text(',
    `            CASE WHEN json_typeof("dirty_domains") = 'array' THEN "dirty_domains" ELSE '[]'::json END`,
    '          ) AS dirty(domain)',
    '          WHERE dirty.domain = known.domain',
    '        )',
    '    );',
    '  IF NOT FOUND THEN',
    "    RAISE EXCEPTION 'data_operations has no status row, so the change to % cannot be recorded; run npm run setup', TG_TABLE_NAME;",
    '  END IF;',
    '  RETURN NULL;',
    'END',
    '$$',
  ].join('\n');

// The statement trigger of the table, then one per refined column.
export const sourceTriggers = ({
  collection,
  columns = {},
}: SourceDeclaration) => [
  `CREATE OR REPLACE TRIGGER "${invalidation}" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${collection}" FOR EACH STATEMENT EXECUTE FUNCTION "${invalidation}"()`,
  ...Object.entries(columns).map(
    ([column, { trigger }]) =>
      `CREATE OR REPLACE TRIGGER "${trigger}" AFTER UPDATE OF "${column}" ON "${collection}" FOR EACH STATEMENT EXECUTE FUNCTION "${invalidation}"()`,
  ),
];
