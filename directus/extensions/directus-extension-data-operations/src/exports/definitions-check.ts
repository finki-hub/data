import { boundedText } from '../text.js';
import { exportError } from './errors.js';
import {
  blockParts,
  isBlock,
  isFixed,
  isNested,
  keySourcesOf,
} from './field-map.js';
import { keySources } from './key-sources.js';
import { readProblems } from './read-rules.js';
import {
  type BlockPart,
  type ExportDefinition,
  type SourceRead,
} from './types.js';

// The structural rules every export definition obeys, checked before any
// read so a malformed definition fails at once and names itself: a
// root-level JSON filename and no two files alike, distinct
// fixed keys, an id field and every source path selected by the read, a
// grouping field selected by each related read, a key field (and the
// parent field of a nested source) selected by each key source, blocks
// with a default layout and distinct parts, and every read under the read
// rules (read-rules.ts).

// A read with the label a refusal names it by.
export type LabelledRead = readonly [string, SourceRead];

// The filename rule of a public file: one root-level JSON name.
export const publicFilenamePattern = /^[a-z0-9][a-z0-9._-]*\.json$/u;

const partLabel = (part: BlockPart): string =>
  isNested(part) ? `${part.infix}:${part.nested}` : part.suffix;

// A part names a suffix or infix, and a nested part a source with a parent.
const isMalformedPart = (part: BlockPart): boolean =>
  isNested(part)
    ? part.infix === '' || keySources[part.nested].parent === undefined
    : part.suffix === '';

// A block needs a default layout, and each layout names its parts once.
const blockProblems = (definition: ExportDefinition): string[] =>
  definition.fields.flatMap((entry) => {
    if (!isBlock(entry)) {
      return [];
    }
    const where = `${definition.filename} blocks ${entry.blocks}`;
    const layouts = [
      entry.layouts.default,
      ...Object.values(entry.layouts.byKey),
    ];
    return [
      ...(entry.layouts.default.length === 0
        ? [`${where} without a default layout`]
        : []),
      ...(blockParts(entry).some((part) => isMalformedPart(part))
        ? [`${where} with an empty or unnested part`]
        : []),
      ...(layouts.every(
        (layout) => new Set(layout.map(partLabel)).size === layout.length,
      )
        ? []
        : [`${where} with a part twice`]),
    ];
  });

// Each key source selects its key field, and a nested one its parent.
const keySourceProblems = (definition: ExportDefinition): string[] =>
  keySourcesOf(definition).flatMap((name) => {
    const source = keySources[name];
    return [
      ...(source.fields.includes(source.key)
        ? []
        : [`${definition.filename} keys ${name} by an omitted field`]),
      ...(source.parent === undefined || source.fields.includes(source.parent)
        ? []
        : [`${definition.filename} nests ${name} by an omitted field`]),
    ];
  });

const fieldProblems = (definition: ExportDefinition): string[] => {
  const { fields, filename, orderBy, related, rows } = definition;
  const problems: string[] = [
    ...blockProblems(definition),
    ...keySourceProblems(definition),
  ];
  const keys = fields.flatMap((entry) => (isFixed(entry) ? [entry.key] : []));
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
      isFixed(entry) &&
      typeof entry.value === 'string' &&
      !rows.fields.includes(entry.value)
    ) {
      problems.push(
        `${filename} key ${entry.key} reads ${entry.value}, which is omitted`,
      );
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

// Every structural problem of the definitions.
export const definitionProblems = (
  definitions: readonly ExportDefinition[],
): string[] => {
  const filenames = definitions.map(({ filename }) => filename);
  return [
    ...(new Set(filenames).size === filenames.length
      ? []
      : ['two definitions publish the same filename']),
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

// Refuses malformed definitions before anything is read.
export const checkDefinitions = (
  definitions: readonly ExportDefinition[],
): void => {
  const problems = definitionProblems(definitions);
  if (problems.length > 0) {
    throw exportError(
      'INVALID_DEFINITION',
      `Invalid export definitions: ${boundedText(problems, { separator: '; ' })}`,
    );
  }
};
