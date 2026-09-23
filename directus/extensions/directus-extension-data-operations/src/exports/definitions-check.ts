import type { ReadinessEntry } from './readiness-types.js';

import { exportError } from './errors.js';
import { isKeyed, keySourcesOf } from './field-map.js';
import { keySources } from './key-sources.js';
import { readProblems } from './read-rules.js';
import { readinessRegistry } from './readiness-registry.js';
import {
  type LabelledRead,
  registryProblems,
  registryReads,
} from './registry-rules.js';
import { type ExportDefinition, publicFilenamePattern } from './types.js';

// The structural rules every export definition obeys, checked before any
// read so a malformed definition fails at once and names itself: a
// filename the storage writer accepts and no two files alike, distinct
// fixed keys, an id field and every source path selected by the read, a
// grouping field selected by each related read, a key field selected by
// each key source, and every read under the read rules (read-rules.ts).
// The readiness-check registry is checked in the same pass.

const fieldProblems = (definition: ExportDefinition): string[] => {
  const { fields, filename, orderBy, related, rows } = definition;
  const problems: string[] = [];
  const keys = fields.flatMap((entry) => (isKeyed(entry) ? [] : [entry.key]));
  if (fields.length === 0 || keys.includes('')) {
    problems.push(`${filename} declares no key or an empty key`);
  }
  if (new Set(keys).size !== keys.length) {
    problems.push(`${filename} declares a key twice`);
  }
  if (!rows.fields.includes(orderBy)) {
    problems.push(`${filename} orders by ${orderBy}, which its read omits`);
  }
  for (const entry of fields) {
    if (
      !isKeyed(entry) &&
      typeof entry.value === 'string' &&
      !rows.fields.includes(entry.value)
    ) {
      problems.push(
        `${filename} key ${entry.key} reads ${entry.value}, which is omitted`,
      );
    }
  }
  for (const name of keySourcesOf(definition)) {
    const source = keySources[name];
    if (!source.fields.includes(source.key)) {
      problems.push(`${filename} keys ${name} by an omitted field`);
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

// Every read a definition makes, labelled for a refusal.
export const definitionReads = (
  definition: ExportDefinition,
): readonly LabelledRead[] => [
  ...keySourcesOf(definition).map((name): LabelledRead => [
    `${definition.filename} keys ${name}`,
    keySources[name],
  ]),
  [`${definition.filename} read rows`, definition.rows],
  ...Object.entries(definition.related).map(([key, read]): LabelledRead => [
    `${definition.filename} read ${key}`,
    read,
  ]),
];

// Every structural problem of the definitions and of the readiness-check
// registry (the shipped one unless another is named).
export const definitionProblems = (
  definitions: readonly ExportDefinition[],
  registry: readonly ReadinessEntry[] = readinessRegistry,
): string[] => {
  const filenames = definitions.map(({ filename }) => filename);
  return [
    ...(new Set(filenames).size === filenames.length
      ? []
      : ['two definitions publish the same filename']),
    ...registryProblems(registry, filenames),
    ...registryReads(registry).flatMap(([label, read]) =>
      readProblems(label, read),
    ),
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

// Refuses malformed definitions or a malformed registry before anything is
// read.
export const checkDefinitions = (
  definitions: readonly ExportDefinition[],
  registry: readonly ReadinessEntry[] = readinessRegistry,
): void => {
  const problems = definitionProblems(definitions, registry);
  if (problems.length > 0) {
    throw exportError(
      'INVALID_DEFINITION',
      `The export definitions are malformed: ${problems.slice(0, 5).join('; ')}.`,
    );
  }
};
