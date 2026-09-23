import { exportError } from './errors.js';
import { factCodes, globalChecks, readinessChecks } from './global-checks.js';
import {
  type ExportDefinition,
  type IssueCode,
  publicFilenamePattern,
  type ReadinessCheck,
  type SourceRead,
} from './types.js';

// The structural rules every export definition obeys, checked before any
// read so a malformed definition fails at once and names itself: a
// filename the storage writer accepts and no two files alike, distinct
// keys, an id field and every source path selected by the read, a
// grouping field selected by each related read, explicit fields only and
// no `_some` or `_none` filter (Directus 12.3.1 drops a two-condition
// `_some` silently and matches two `_some` blocks across different rows).
// The read rules hold for the global readiness checks too, and every
// readiness code has one kind and one page wherever it is declared.

const forbiddenOperators: ReadonlySet<string> = new Set(['_none', '_some']);

// Every object key anywhere inside a filter.
const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => keysOf(item));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysOf(inner),
  ]);
};

const readProblems = (label: string, read: SourceRead): string[] => {
  const problems: string[] = [];
  if (read.fields.length === 0) {
    problems.push(`${label} selects no field`);
  }
  if (read.fields.some((field) => field === '*' || field.endsWith('.*'))) {
    problems.push(`${label} selects a wildcard`);
  }
  if (new Set(read.fields).size !== read.fields.length) {
    problems.push(`${label} selects a field twice`);
  }
  if (keysOf(read.filter).some((key) => forbiddenOperators.has(key))) {
    problems.push(`${label} filters with _some or _none`);
  }
  return problems;
};

const fieldProblems = (definition: ExportDefinition): string[] => {
  const { fields, filename, orderBy, related, rows } = definition;
  const problems: string[] = [];
  const keys = fields.map(({ key }) => key);
  if (keys.length === 0 || keys.includes('')) {
    problems.push(`${filename} declares no key or an empty key`);
  }
  if (new Set(keys).size !== keys.length) {
    problems.push(`${filename} declares a key twice`);
  }
  if (!rows.fields.includes(orderBy)) {
    problems.push(`${filename} orders by ${orderBy}, which its read omits`);
  }
  for (const { key, value } of fields) {
    if (typeof value === 'string' && !rows.fields.includes(value)) {
      problems.push(`${filename} key ${key} reads ${value}, which is omitted`);
    }
  }
  for (const [name, read] of Object.entries(related)) {
    if (!read.fields.includes(read.by)) {
      problems.push(`${filename} read ${name} groups by an omitted field`);
    }
  }
  if (!Number.isSafeInteger(definition.maxBytes) || definition.maxBytes < 1) {
    problems.push(`${filename} has no positive size bound`);
  }
  return problems;
};

type LabelledRead = readonly [string, SourceRead];

const checkReads = (
  owner: string,
  checks: readonly ReadinessCheck[],
): LabelledRead[] =>
  checks.flatMap((check, index) =>
    Object.entries(check.reads).map(([key, read]): LabelledRead => [
      `${owner} check ${index + 1} read ${key}`,
      read,
    ]),
  );

// Every read a definition and its checks make, labelled for a refusal.
export const definitionReads = (
  definition: ExportDefinition,
): readonly LabelledRead[] => [
  [`${definition.filename} read rows`, definition.rows],
  ...Object.entries(definition.related).map(([key, read]): LabelledRead => [
    `${definition.filename} read ${key}`,
    read,
  ]),
  ...checkReads(definition.filename, definition.checks),
];

// Every read of the global readiness checks, labelled for a refusal.
export const globalReads = (
  globals: readonly ReadinessCheck[] = globalChecks,
): readonly LabelledRead[] => checkReads('global', globals);

const issueText = ({ collection, kind }: IssueCode) =>
  `${kind} of ${collection}`;

// A readiness code is decided by its one declaration: one declared twice
// with another kind or page would let a warning hide a blocker.
// Grouped through Map.groupBy: the ESLint autofix for the get-then-set
// pattern emits Map#getOrInsert, which Node 24 does not ship.
const codeProblems = (checks: readonly ReadinessCheck[]): string[] =>
  Map.groupBy(
    [
      ...Object.entries(factCodes),
      ...checks.flatMap(({ codes }) => Object.entries(codes)),
    ],
    ([code]) => code,
  )
    .entries()
    .flatMap(([code, declarations]) => {
      const kinds = new Set(declarations.map(([, issue]) => issueText(issue)));
      return kinds.size > 1
        ? [
            `readiness code ${code} is declared as ${[...kinds].join(' and as ')}`,
          ]
        : [];
    })
    .toArray();

// Every structural problem of the definitions and of the global checks
// (the shipped ones unless others are named).
export const definitionProblems = (
  definitions: readonly ExportDefinition[],
  globals: readonly ReadinessCheck[] = globalChecks,
): string[] => {
  const filenames = definitions.map(({ filename }) => filename);
  return [
    ...(new Set(filenames).size === filenames.length
      ? []
      : ['two definitions publish the same filename']),
    ...globalReads(globals).flatMap(([label, read]) =>
      readProblems(label, read),
    ),
    ...codeProblems(readinessChecks(definitions, globals)),
    ...definitions.flatMap((definition) => [
      ...(publicFilenamePattern.test(definition.filename)
        ? []
        : [`${definition.filename} is not a root-level JSON filename`]),
      ...fieldProblems(definition),
      ...definitionReads(definition).flatMap(([label, read]) =>
        readProblems(label, read),
      ),
    ]),
  ];
};

// Refuses a malformed list of definitions before anything is read.
export const checkDefinitions = (
  definitions: readonly ExportDefinition[],
): void => {
  const problems = definitionProblems(definitions);
  if (problems.length > 0) {
    throw exportError(
      'INVALID_DEFINITION',
      `The export definitions are malformed: ${problems.slice(0, 5).join('; ')}.`,
    );
  }
};
