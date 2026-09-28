import type { FieldFilter, FieldFilterOperator, Filter } from '@directus/types';

// Filters on a field, or on a dot path through M2O relations (`a.b` nests
// as { a: { b: ... } }, the plain path Directus follows with one join per
// relation). Logical operators stay at the top of each filter, where
// Studio's filter builder shows them.

const on = (path: string, operator: FieldFilterOperator): FieldFilter => {
  const [head = '', ...rest] = path.split('.');
  return {
    [head]: rest.length === 0 ? operator : on(rest.join('.'), operator),
  };
};

// A text field holding a value: neither NULL nor ''. Directus's REST
// query validation refuses an empty string as a filter value, so Studio
// could not open a view filtering with `_neq: ''`; `_nempty` means the
// same and passes it.
export const filled = (path: string): Filter => on(path, { _nempty: true });

// A text field holding no value: NULL or '' (`_empty`).
export const blank = (path: string): Filter => on(path, { _empty: true });
