import { z } from 'zod';

import type { CountSource, ReadinessEntry } from './readiness-types.js';
import type {
  IssueCounts,
  ReadinessCheck,
  Row,
  SourceRead,
  SourceRows,
} from './types.js';

import { rowsOf, type SourceReader } from './engine.js';
import { exportError } from './errors.js';

// How readiness counts the registry in one bounded engine step: the
// coordinator and snapshot facts for their entries, one native aggregate
// per count entry, and each check once for the codes it counts. Every read
// names its fields; an aggregate answers one number, never a record.

type Facts = {
  readonly snapshot: IssueCounts;
  readonly status: IssueCounts;
};

const countText = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d{1,15}$/u),
]);

// The one number an aggregate read answered (Directus answers text).
const aggregateCount = (
  label: string,
  read: SourceRead,
  answer: unknown,
): number => {
  const [field = 'id'] = read.fields;
  const parsed = z
    .tuple([
      z.object({
        [read.aggregate ?? 'count']: z.object({ [field]: countText }),
      }),
    ])
    .safeParse(answer);
  if (!parsed.success) {
    throw exportError('INVALID_READ', `${label} answered no count`);
  }
  return Number(parsed.data[0][read.aggregate ?? 'count']?.[field]);
};

// The aggregate read of a count entry, on its page collection.
export const countRead = (page: string, source: CountSource): SourceRead => ({
  aggregate: source.aggregate,
  collection: page,
  fields: [source.field],
  filter: source.filter,
  sort: [],
});

const whole = (label: string, count: unknown): number => {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw exportError('INVALID_DEFINITION', `${label} answered no whole count`);
  }
  return count;
};

// The sources of a check: rows for a row read, one `{ count }` row for an
// aggregate read.
const checkSources = async (
  check: ReadinessCheck,
  reader: SourceReader,
): Promise<SourceRows> => {
  const sources: Record<string, readonly Row[]> = {};
  for (const [key, read] of Object.entries(check.reads)) {
    const label = `readiness read ${key}`;
    const answer = await reader(read);
    sources[key] =
      read.aggregate === undefined
        ? rowsOf(label, answer)
        : [{ count: aggregateCount(label, read, answer) }];
  }
  return sources;
};

// Runs a check once and keeps its counts of the codes that name it; a
// code it answers that no entry gives it, or a count that is not a whole
// number, is refused.
const runCheck = async (
  check: ReadinessCheck,
  codes: readonly string[],
  reader: SourceReader,
): Promise<ReadonlyArray<readonly [string, number]>> => {
  const answered = check.evaluate(await checkSources(check, reader));
  const stray = Object.keys(answered).find((code) => !codes.includes(code));
  if (stray !== undefined) {
    throw exportError(
      'INVALID_DEFINITION',
      `Readiness check: unregistered code ${stray.slice(0, 80)}`,
    );
  }
  return codes.map((code) => [code, whole(code, answered[code] ?? 0)]);
};

// Every fact names a registered code of its source; an unknown state is
// refused, never dropped.
const factKinds = ['snapshot', 'status'] as const;

const checkFacts = (
  registry: readonly ReadinessEntry[],
  facts: Facts,
): void => {
  for (const kind of factKinds) {
    const codes = Object.keys(facts[kind]);
    for (const code of codes) {
      const entry = registry.find((candidate) => candidate.code === code);
      if (entry?.source.kind !== kind) {
        throw exportError(
          'INVALID_READ',
          `Readiness has no ${kind} code for ${code.slice(0, 80)}`,
        );
      }
    }
  }
};

// Answers each distinct read once per run, whichever definition or check
// asks for it.
export const sharedReader = (reader: SourceReader): SourceReader => {
  const answers = new Map<string, Promise<readonly unknown[]>>();
  return (read) => {
    const key = JSON.stringify(read);
    const known = answers.get(key);
    if (known !== undefined) {
      return known;
    }
    const answer = reader(read);
    answers.set(key, answer);
    return answer;
  };
};

// The count of every registry entry, by code.
export const registryCounts = async (
  registry: readonly ReadinessEntry[],
  facts: Facts,
  reader: SourceReader,
): Promise<ReadonlyMap<string, number>> => {
  checkFacts(registry, facts);
  const counts = new Map<string, number>();
  const checks = new Map<ReadinessCheck, string[]>();
  for (const { code, page, source } of registry) {
    if (source.kind === 'check') {
      checks.set(source.check, [...(checks.get(source.check) ?? []), code]);
    } else if (source.kind === 'count') {
      const read = countRead(page, source);
      counts.set(code, aggregateCount(code, read, await reader(read)));
    } else {
      counts.set(code, whole(code, facts[source.kind][code] ?? 0));
    }
  }
  for (const [check, codes] of checks) {
    const answered = await runCheck(check, codes, reader);
    for (const [code, count] of answered) {
      counts.set(code, count);
    }
  }
  return counts;
};
