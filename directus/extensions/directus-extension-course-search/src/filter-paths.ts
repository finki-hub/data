import { z } from 'zod';

// Directus 12.3.1 joins the rows a relational filter path reaches without
// the caller's row permissions on them: it checks the caller's field
// permission on every segment of the path (a denied one answers 403) and
// applies the related collection's row permissions only inside
// `_some`/`_none`, which Search refuses (apply-query/add-join.js,
// apply-query/filter/index.js). A path that comes back to a collection it
// has passed, such as Entry -> Memberships -> Moodle User, would join
// other users' rows and answer yes or no about their names, addresses and
// lines. So a Search filter path passes each collection at most once from
// the Moodle users: through the caller's own users' memberships to the
// shared entries, their mappings and on, never back to a membership or a
// user. A function key such as `count(memberships)` counts the rows of its
// relation, so it passes that collection too. A path also names at most
// as many fields as REST allows (MAX_RELATIONAL_DEPTH): the item services
// the endpoint calls skip the REST query validation that checks it.

// The part of a Directus relation a path follows: an M2O field
// (`collection.field` -> `related_collection`) or its O2M alias
// (`related_collection.meta.one_field` -> `collection`).
export type PathRelation = {
  readonly collection: string;
  readonly field: string;
  readonly meta: null | { readonly one_field: null | string };
  readonly related_collection: null | string;
};

type PathRules = {
  readonly maxDepth: number;
  readonly relations: readonly PathRelation[];
  readonly root: string;
};

// Where a path has got to: the collection, the fields it named, the
// collections it passed, and why Search refuses it, if it does: a fact
// the endpoint places after "Invalid criteria: filter: ".
type Walk = {
  readonly collection: string;
  readonly depth: number;
  readonly passed: ReadonlySet<string>;
  readonly problem?: string;
};

const functionKey = /^[^()]+\((?<field>[^()]+)\)$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The collection a filter key leads to from `collection`, when the key
// (or the field of its function, or a many-to-any `field:scope`) is
// relational.
const relatedCollection = (
  relations: readonly PathRelation[],
  collection: string,
  key: string,
): string | undefined => {
  const [head = key, scope] = key.split(':');
  const field = functionKey.exec(head)?.groups?.['field']?.trim() ?? head;
  const relation = relations.find(
    (candidate) =>
      (candidate.collection === collection && candidate.field === field) ||
      (candidate.related_collection === collection &&
        candidate.meta?.one_field === field),
  );
  if (relation === undefined) return undefined;
  return relation.collection === collection && relation.field === field
    ? (relation.related_collection ?? scope)
    : relation.collection;
};

// One field further: into the related collection, or on the same
// collection for a plain field; refused when the path names too many
// fields or has passed the related collection already.
const nextWalk = (key: string, walk: Walk, rules: PathRules): Walk => {
  const depth = walk.depth + 1;
  if (depth > rules.maxDepth) {
    return {
      ...walk,
      depth,
      problem: `path exceeds ${String(rules.maxDepth)} fields`,
    };
  }
  const related = relatedCollection(rules.relations, walk.collection, key);
  if (related === undefined) return { ...walk, depth };
  if (walk.passed.has(related)) {
    return { ...walk, depth, problem: `path passes ${related} twice` };
  }
  return {
    collection: related,
    depth,
    passed: new Set([...walk.passed, related]),
  };
};

const walkProblem = (
  filter: unknown,
  walk: Walk,
  rules: PathRules,
): string | undefined => {
  const items = Array.isArray(filter) ? filter : [filter];
  for (const item of items) {
    if (!isRecord(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      // An operator, group or quantifier stays where it is.
      const next = key.startsWith('_') ? walk : nextWalk(key, walk, rules);
      if (next.problem !== undefined) return next.problem;
      const problem = walkProblem(value, next, rules);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
};

// Why Search refuses a native filter's paths, or undefined when each path
// passes every collection at most once and names at most `maxDepth`
// fields.
export const filterPathProblem = (
  filter: unknown,
  rules: PathRules,
): string | undefined =>
  walkProblem(
    filter,
    { collection: rules.root, depth: 0, passed: new Set([rules.root]) },
    rules,
  );

// Directus's own limit on the fields of a query path: MAX_RELATIONAL_DEPTH
// (default 10), and never below 2 (utils/validate-query.js).
export const relationalDepthLimit = (
  env: Readonly<Record<string, unknown>>,
): number => {
  const configured = z.coerce.number().safeParse(env['MAX_RELATIONAL_DEPTH']);
  return configured.success ? Math.max(configured.data, 2) : 2;
};
