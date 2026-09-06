import type { FieldFilterOperator, Filter } from '@directus/types';

import { z } from 'zod';

type Comparable = number | string;
type CourseSearchFieldFilterOperator = FieldFilterOperator & {
  _nicontains?: string;
  _niends_with?: string;
};
type NativeFilterInput =
  | Readonly<Record<string, NativeFilterOperators>>
  | { readonly _and: readonly NativeFilterInput[] }
  | { readonly _or: readonly NativeFilterInput[] };

type NativeFilterOperators = {
  readonly _between?: readonly Comparable[] | undefined;
  readonly _contains?: string | undefined;
  readonly _empty?: boolean | undefined;
  readonly _ends_with?: string | undefined;
  readonly _eq?: Scalar | undefined;
  readonly _gt?: Comparable | undefined;
  readonly _gte?: Comparable | undefined;
  readonly _icontains?: string | undefined;
  readonly _iends_with?: string | undefined;
  readonly _in?: readonly Comparable[] | undefined;
  readonly _istarts_with?: string | undefined;
  readonly _lt?: Comparable | undefined;
  readonly _lte?: Comparable | undefined;
  readonly _nbetween?: readonly Comparable[] | undefined;
  readonly _ncontains?: string | undefined;
  readonly _nempty?: boolean | undefined;
  readonly _nends_with?: string | undefined;
  readonly _neq?: Scalar | undefined;
  readonly _nicontains?: string | undefined;
  readonly _niends_with?: string | undefined;
  readonly _nin?: readonly Comparable[] | undefined;
  readonly _nistarts_with?: string | undefined;
  readonly _nnull?: boolean | undefined;
  readonly _nstarts_with?: string | undefined;
  readonly _null?: boolean | undefined;
  readonly _starts_with?: string | undefined;
};

type Scalar = boolean | null | number | string;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const comparable = z.union([z.string(), z.number()]);
const operators: z.ZodType<NativeFilterOperators> = z
  .object({
    _between: z.array(comparable).optional(),
    _contains: z.string().optional(),
    _empty: z.boolean().optional(),
    _ends_with: z.string().optional(),
    _eq: scalar.optional(),
    _gt: comparable.optional(),
    _gte: comparable.optional(),
    _icontains: z.string().optional(),
    _iends_with: z.string().optional(),
    _in: z.array(comparable).optional(),
    _istarts_with: z.string().optional(),
    _lt: comparable.optional(),
    _lte: comparable.optional(),
    _nbetween: z.array(comparable).optional(),
    _ncontains: z.string().optional(),
    _nempty: z.boolean().optional(),
    _nends_with: z.string().optional(),
    _neq: scalar.optional(),
    _nicontains: z.string().optional(),
    _niends_with: z.string().optional(),
    _nin: z.array(comparable).optional(),
    _nistarts_with: z.string().optional(),
    _nnull: z.boolean().optional(),
    _nstarts_with: z.string().optional(),
    _null: z.boolean().optional(),
    _starts_with: z.string().optional(),
  })
  .strict();

const maxNestingDepth = 24;

const isNested = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

// Breadth-first nesting depth, so deep input never reaches the recursive schema.
const nestingDepth = (value: unknown): number => {
  let depth = 0;
  let level: readonly object[] = isNested(value) ? [value] : [];
  while (level.length > 0 && depth <= maxNestingDepth) {
    level = level.flatMap((node) => Object.values(node).filter(isNested));
    depth += 1;
  }
  return depth;
};

const nativeFilterInput: z.ZodType<NativeFilterInput> = z.lazy(() =>
  z.union([
    z.object({ _and: z.array(nativeFilterInput) }).strict(),
    z.object({ _or: z.array(nativeFilterInput) }).strict(),
    z.record(z.string(), operators),
  ]),
);

const setOperator = <Key extends keyof CourseSearchFieldFilterOperator>(
  output: CourseSearchFieldFilterOperator,
  key: Key,
  value: CourseSearchFieldFilterOperator[Key] | undefined,
): void => {
  if (value !== undefined) output[key] = value;
};

const toFieldFilterOperators = (
  input: NativeFilterOperators,
): CourseSearchFieldFilterOperator => {
  const output: CourseSearchFieldFilterOperator = {};
  setOperator(output, '_between', input._between && [...input._between]);
  setOperator(output, '_contains', input._contains);
  setOperator(output, '_empty', input._empty);
  setOperator(output, '_ends_with', input._ends_with);
  setOperator(output, '_eq', input._eq);
  setOperator(output, '_gt', input._gt);
  setOperator(output, '_gte', input._gte);
  setOperator(output, '_icontains', input._icontains);
  setOperator(output, '_iends_with', input._iends_with);
  setOperator(output, '_in', input._in && [...input._in]);
  setOperator(output, '_istarts_with', input._istarts_with);
  setOperator(output, '_lt', input._lt);
  setOperator(output, '_lte', input._lte);
  setOperator(output, '_nbetween', input._nbetween && [...input._nbetween]);
  setOperator(output, '_ncontains', input._ncontains);
  setOperator(output, '_nempty', input._nempty);
  setOperator(output, '_nends_with', input._nends_with);
  setOperator(output, '_neq', input._neq);
  setOperator(output, '_nicontains', input._nicontains);
  setOperator(output, '_nnull', input._nnull);
  setOperator(output, '_nin', input._nin && [...input._nin]);
  setOperator(output, '_niends_with', input._niends_with);
  setOperator(output, '_nistarts_with', input._nistarts_with);
  setOperator(output, '_nstarts_with', input._nstarts_with);
  setOperator(output, '_null', input._null);
  setOperator(output, '_starts_with', input._starts_with);
  return output;
};

const isAndFilter = (
  input: NativeFilterInput,
): input is { readonly _and: readonly NativeFilterInput[] } =>
  '_and' in input && Array.isArray(input._and);

const isOrFilter = (
  input: NativeFilterInput,
): input is { readonly _or: readonly NativeFilterInput[] } =>
  '_or' in input && Array.isArray(input._or);

const toDirectusFilter = (input: NativeFilterInput): Filter => {
  if (isAndFilter(input)) {
    return { _and: input._and.map(toDirectusFilter) };
  }
  if (isOrFilter(input)) {
    return { _or: input._or.map(toDirectusFilter) };
  }

  const output: Record<string, CourseSearchFieldFilterOperator> = {};
  for (const [field, fieldOperators] of Object.entries(input)) {
    output[field] = toFieldFilterOperators(fieldOperators);
  }
  return output;
};

export const nativeFilter = z
  .unknown()
  .superRefine((value, context) => {
    if (nestingDepth(value) > maxNestingDepth) {
      context.addIssue({
        code: 'custom',
        message: `Filters may nest at most ${String(maxNestingDepth)} levels`,
      });
    }
  })
  .pipe(nativeFilterInput.transform(toDirectusFilter));
