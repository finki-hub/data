import type { ReadinessCheck, SourceRead } from './types.js';

import { usesSomeOrNone } from './read-rules.js';
import { countRead } from './readiness-run.js';
import { type ReadinessEntry, severities } from './readiness-types.js';

// The structural rules of the readiness-check registry, checked before any
// read like the definition rules: one entry per code, a severity from the
// closed set, a blocker gating declared files and a warning gating none,
// one Needs review bookmark per name, a generation-scoped view that shows
// the generation, and reads under the same rules as every export read.

export type LabelledRead = readonly [string, SourceRead];

const codePattern = /^[a-z][a-z0-9_]*$/u;

// Every read the registry makes: one aggregate per count entry and the
// reads of each check once, labelled for a refusal.
export const registryReads = (
  registry: readonly ReadinessEntry[],
): readonly LabelledRead[] => {
  const checks = new Map<ReadinessCheck, string>();
  const reads: LabelledRead[] = [];
  for (const { code, page, source } of registry) {
    if (source.kind === 'count') {
      reads.push([`readiness ${code}`, countRead(page, source)]);
    } else if (source.kind === 'check' && !checks.has(source.check)) {
      checks.set(source.check, code);
    }
  }
  for (const [check, code] of checks) {
    for (const [key, read] of Object.entries(check.reads)) {
      reads.push([`readiness check of ${code} read ${key}`, read]);
    }
  }
  return reads;
};

// A Needs review view lists fields, filters without `_some`/`_none`, and
// shows the generation when its records belong to one.
const reviewProblems = ({
  code,
  generationScoped,
  review,
}: ReadinessEntry): string[] => {
  if (review === undefined) {
    return [];
  }
  return [
    ...(review.fields.length === 0 ? [`review of ${code} lists no field`] : []),
    ...(usesSomeOrNone(review.filter)
      ? [`review of ${code} filters with _some or _none`]
      : []),
    ...(generationScoped && !review.fields.includes('generation')
      ? [`generation-scoped review of ${code} does not show the generation`]
      : []),
  ];
};

const entryProblems = (
  entry: ReadinessEntry,
  filenames: ReadonlySet<string>,
): string[] => {
  const { code, description, gates, severity } = entry;
  const problems: string[] = [];
  if (!codePattern.test(code)) {
    problems.push(`readiness code ${code.slice(0, 60)} is not snake case`);
  }
  if (severities.every((known) => known !== severity)) {
    problems.push(`readiness code ${code} has no known severity`);
  }
  if (description.trim() === '') {
    problems.push(`readiness code ${code} has no description`);
  }
  if (severity === 'blocker' && gates.length === 0) {
    problems.push(`blocker ${code} gates no file`);
  }
  if (severity === 'warning' && gates.length > 0) {
    problems.push(`warning ${code} gates a file`);
  }
  for (const gate of gates) {
    if (!filenames.has(gate)) {
      problems.push(
        `readiness code ${code} gates ${gate}, which no definition publishes`,
      );
    }
  }
  return [...problems, ...reviewProblems(entry)];
};

const duplicates = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

// Every structural problem of the registry against the published files.
export const registryProblems = (
  registry: readonly ReadinessEntry[],
  filenames: readonly string[],
): string[] => {
  const published = new Set(filenames);
  return [
    ...duplicates(registry.map(({ code }) => code)).map(
      (code) => `readiness code ${code} is declared twice`,
    ),
    ...duplicates(
      registry.flatMap(({ review }) =>
        review === undefined ? [] : [review.bookmark],
      ),
    ).map((bookmark) => `two readiness reviews share the bookmark ${bookmark}`),
    ...registry.flatMap((entry) => entryProblems(entry, published)),
  ];
};
