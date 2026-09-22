import { z } from 'zod';

export const sourceMapStatuses = ['existing', 'pending', 'unresolved'] as const;

// One planned or recorded source-to-target relationship: a target row the
// converters create for a source row, or a link column they set on it.
// `existing` carries the target id a converter must reuse instead of
// creating a second row; `unresolved` retains the source label for review.
export const sourceMapEntrySchema = z.object({
  relation: z.string().min(1),
  sourceCollection: z.string().min(1),
  sourceId: z.union([z.number().int(), z.string().min(1)]),
  status: z.enum(sourceMapStatuses),
  targetCollection: z.string().min(1),
  targetId: z.number().int().nullable(),
});

export type SourceMapEntry = z.infer<typeof sourceMapEntrySchema>;

const collator = new Intl.Collator('en');

export const sourceMapKey = (entry: SourceMapEntry): string =>
  `${entry.sourceCollection}\u{0}${entry.relation}\u{0}${String(entry.sourceId)}`;

const compareIds = (
  left: SourceMapEntry['sourceId'],
  right: SourceMapEntry['sourceId'],
): number => {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return collator.compare(String(left), String(right));
};

const compareEntries = (left: SourceMapEntry, right: SourceMapEntry): number =>
  collator.compare(left.sourceCollection, right.sourceCollection) ||
  collator.compare(left.relation, right.relation) ||
  compareIds(left.sourceId, right.sourceId);

// Merges id map entries; a later entry for the same source and relation
// replaces the earlier one. The result is sorted so two runs over the same
// data record byte-identical maps.
export const mergeSourceMap = (
  ...lists: ReadonlyArray<readonly SourceMapEntry[]>
): readonly SourceMapEntry[] => {
  const merged = new Map<string, SourceMapEntry>();
  for (const list of lists) {
    for (const entry of list) {
      merged.set(sourceMapKey(entry), entry);
    }
  }
  return merged.values().toArray().toSorted(compareEntries);
};

export const parseSourceMap = (value: unknown): readonly SourceMapEntry[] =>
  z.array(sourceMapEntrySchema).parse(value);
