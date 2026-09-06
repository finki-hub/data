import type { Filter } from '@directus/types';
import { z } from 'zod';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const comparable = z.union([z.string(), z.number()]);
const operators = z.object({
  _eq: scalar.optional(), _neq: scalar.optional(),
  _lt: comparable.optional(), _lte: comparable.optional(),
  _gt: comparable.optional(), _gte: comparable.optional(),
  _in: z.array(comparable).optional(), _nin: z.array(comparable).optional(),
  _between: z.array(comparable).optional(), _nbetween: z.array(comparable).optional(),
  _null: z.boolean().optional(), _nnull: z.boolean().optional(),
  _empty: z.boolean().optional(), _nempty: z.boolean().optional(),
  _contains: z.string().optional(), _ncontains: z.string().optional(),
  _icontains: z.string().optional(), _nicontains: z.string().optional(),
  _starts_with: z.string().optional(), _nstarts_with: z.string().optional(),
  _istarts_with: z.string().optional(), _nistarts_with: z.string().optional(),
  _ends_with: z.string().optional(), _nends_with: z.string().optional(),
  _iends_with: z.string().optional(), _niends_with: z.string().optional(),
}).strict();

export const nativeFilter: z.ZodType<Filter> = z.lazy(() => z.union([
  z.object({ _and: z.array(nativeFilter) }).strict(),
  z.object({ _or: z.array(nativeFilter) }).strict(),
  z.record(z.string(), operators),
]));
