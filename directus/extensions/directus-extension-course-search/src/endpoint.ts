import type { Accountability, Filter, Query } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import { countOf, readAll, readPage } from './count-order.js';
import {
  criteriaProblem,
  criteriaSchema,
  exportCriteriaSchema,
  invalidCriteria,
  type MatchMode,
  matchModes,
} from './criteria.js';
import { toCsv } from './csv.js';
import { filterPathProblem, relationalDepthLimit } from './filter-paths.js';
import {
  countedCourseCondition,
  countedForAny,
  courseCondition,
  splitHistory,
} from './history.js';
import { mailName, nameMatcher, nameWords } from './name-match.js';

const macedonianCollator = new Intl.Collator('mk');

declare global {
  namespace Express {
    interface Request {
      accountability?: Accountability;
    }
  }
}

const historyRows = z.array(z.object({ Courses: z.string().nullish() }));
const courseRows = z.array(z.object({ name: z.string().nullish() }));
const nameRows = z.array(
  z.object({
    id: z.union([z.string(), z.number()]),
    Mail: z.string().nullish(),
    Name: z.string().nullish(),
  }),
);
const matchedRows = z.array(
  z
    .object({
      Courses: z.string().nullish(),
      history_memberships: z
        .array(z.object({ entry: z.object({ label: z.string() }).nullish() }))
        .optional(),
    })
    .loose(),
);
const resultFields = [
  'id',
  'Name',
  'Mail',
  'Profile_new',
  'Profile_old',
  'Courses',
  'Courses Count',
] as const;

type CourseSearchQuery = {
  readonly filter: Filter;
  readonly search?: string;
};

type SearchCriteria = {
  readonly exclude: readonly string[];
  readonly filter?: Filter | null | undefined;
  readonly include: readonly string[];
  readonly match?: MatchMode;
  readonly search?: null | string | undefined;
};

// Directus's own error body: one error, its code in `extensions`.
const errorBody = (code: string, message: string) => ({
  errors: [{ extensions: { code }, message }],
});

// The users a name query picks, or undefined when it names no word. A
// query word may start a word of the name or of the mail address before
// its @. The
// names are matched here, not by a filter, because a Latin query reads a
// Cyrillic name in more spellings than a filter can list.
export const nameMatchIds = async (
  read: Reader,
  name: null | string | undefined,
): Promise<Array<number | string> | undefined> => {
  if (nameWords(name).length === 0) return undefined;
  const matches = nameMatcher(name ?? '');
  const ids: Array<number | string> = [];
  // Read on until a page comes back empty: QUERY_LIMIT_MAX may cut a page
  // of limit -1 short.
  for (let offset = 0; ;) {
    const rows = nameRows.parse(
      await read({
        fields: ['id', 'Name', 'Mail'],
        limit: -1,
        offset,
        sort: ['id'],
      }),
    );
    if (rows.length === 0) return ids;
    for (const row of rows)
      if (matches(`${row.Name ?? ''} ${mailName(row.Mail)}`)) ids.push(row.id);
    offset += rows.length;
  }
};

// The search query, narrowed to `ids` when a name query picked them.
export const buildSearchQuery = (
  criteria: SearchCriteria,
  ids?: ReadonlyArray<number | string>,
): CourseSearchQuery => {
  const condition =
    criteria.match === 'course' ? countedCourseCondition : courseCondition;
  return {
    filter: {
      _and: [
        ...(criteria.filter ? [criteria.filter] : []),
        ...(ids ? [{ id: { _in: [...ids] } }] : []),
        ...criteria.include.map((course) => condition(course)),
        ...criteria.exclude.map((course) => condition(course, true)),
      ],
    },
    ...(criteria.search && { search: criteria.search }),
  };
};

type MatchCriteria = Pick<SearchCriteria, 'include' | 'match'>;

// The fields and deep query of a result page. By course, they also bring
// each user's memberships whose line counts for a picked course, so the
// page can mark the lines that matched.
export const matchedLinesQuery = (
  criteria: MatchCriteria,
): { readonly deep?: Query['deep']; readonly fields: string[] } =>
  criteria.match === 'course' && criteria.include.length > 0
    ? {
        deep: {
          history_memberships: {
            _filter: countedForAny(criteria.include),
            _limit: -1,
          },
        },
        fields: [...resultFields, 'history_memberships.entry.label'],
      }
    : { fields: [...resultFields] };

// Each row with `matched`, the history lines the picked courses matched in
// history order, and without the memberships read to find them.
export const withMatchedLines = (
  rows: readonly unknown[],
  criteria: MatchCriteria,
): Array<Record<string, unknown>> =>
  matchedRows.parse(rows).map(({ history_memberships, ...row }) => {
    const picked = new Set(
      criteria.match === 'course'
        ? (history_memberships ?? []).flatMap(({ entry }) =>
            entry ? [entry.label] : [],
          )
        : criteria.include,
    );
    return {
      ...row,
      matched: splitHistory(row.Courses).filter((line) => picked.has(line)),
    };
  });

type Reader = (query: Record<string, unknown>) => Promise<readonly unknown[]>;

// The names a picker offers: every course the last count counted a line
// for, or every line of the Moodle users' histories.
export const optionNames = async (
  read: Reader,
  match: MatchMode,
): Promise<Set<string>> => {
  const names = new Set<string>();
  if (match === 'course') {
    const rows = courseRows.parse(
      await read({
        fields: ['name'],
        filter: { counted_lines: { id: { _nnull: true } } },
        limit: -1,
      }),
    );
    for (const { name } of rows) if (name) names.add(name);
    return names;
  }
  for (let offset = 0; ; offset += 500) {
    const rows = historyRows.parse(
      await read({ fields: ['Courses'], limit: 500, offset, sort: ['id'] }),
    );
    for (const row of rows)
      for (const course of splitHistory(row.Courses)) names.add(course);
    if (rows.length < 500) return names;
  }
};

const optionsMatch = z.enum(matchModes).catch('line');

type Criteria = z.infer<typeof exportCriteriaSchema>;

const exportRows = z.array(
  z
    .object({
      Courses: z.string().nullish(),
      'Courses Count': z.number().nullish(),
      Mail: z.string().nullish(),
      matched: z.array(z.string()),
      Name: z.string(),
      Profile_new: z.string().nullish(),
      Profile_old: z.string().nullish(),
    })
    .loose(),
);

// The criteria of a request, or the line that refuses them. A filter path
// that names more fields than REST allows is refused like an unsupported
// filter, with its own reason.
export const acceptCriteria = <T extends Criteria>(
  schema: z.ZodType<T>,
  body: unknown,
  maxDepth: number,
): { readonly criteria: T } | { readonly problem: string } => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { problem: criteriaProblem(parsed.error) };
  const pathProblem = filterPathProblem(parsed.data.filter, maxDepth);
  return pathProblem === undefined
    ? { criteria: parsed.data }
    : { problem: invalidCriteria('filter', pathProblem) };
};

export default defineEndpoint((router, { env, getSchema, services }) => {
  const maxDepth = relationalDepthLimit(env);
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!request.accountability?.user) {
      response
        .status(403)
        .json(errorBody('FORBIDDEN', 'Authentication required'));
      return;
    }
    next();
  });

  router.get('/options', async (request, response, next) => {
    try {
      const match = optionsMatch.parse(request.query['match']);
      const items = new services.ItemsService(
        match === 'course' ? 'courses' : 'moodle_users',
        { accountability: request.accountability, schema: await getSchema() },
      );
      const courses = await optionNames(
        (query) => items.readByQuery(query),
        match,
      );
      response.json({
        data: [...courses].sort((left, right) =>
          macedonianCollator.compare(left, right),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  // The caller's Moodle users and the query of the criteria, or undefined
  // when a name query picks no one.
  const searchQuery = async (
    accountability: Accountability | undefined,
    criteria: Criteria,
  ) => {
    const items = new services.ItemsService('moodle_users', {
      accountability,
      schema: await getSchema(),
    });
    const ids = await nameMatchIds(
      (nameQuery) => items.readByQuery(nameQuery),
      criteria.name,
    );
    return ids?.length === 0
      ? undefined
      : { items, query: buildSearchQuery(criteria, ids) };
  };

  router.post('/search', async (request, response, next) => {
    try {
      const accepted = acceptCriteria(criteriaSchema, request.body, maxDepth);
      if ('problem' in accepted) {
        response
          .status(400)
          .json(errorBody('INVALID_PAYLOAD', accepted.problem));
        return;
      }
      const { criteria } = accepted;
      const search = await searchQuery(request.accountability, criteria);
      if (search === undefined) {
        response.json({ data: [], total: 0 });
        return;
      }
      const { items, query } = search;
      const [rows, counts] = await Promise.all([
        readPage(items, {
          ...matchedLinesQuery(criteria),
          page: criteria.page,
          query,
          sort: criteria.sort,
        }),
        items.readByQuery({ ...query, aggregate: { count: ['id'] } }),
      ]);
      response.json({
        data: withMatchedLines(rows, criteria),
        total: countOf(counts),
      });
    } catch (error) {
      next(error);
    }
  });

  // Every matching user as CSV, in the order of the search.
  router.post('/export', async (request, response, next) => {
    try {
      const accepted = acceptCriteria(
        exportCriteriaSchema,
        request.body,
        maxDepth,
      );
      if ('problem' in accepted) {
        response
          .status(400)
          .json(errorBody('INVALID_PAYLOAD', accepted.problem));
        return;
      }
      const { criteria } = accepted;
      const search = await searchQuery(request.accountability, criteria);
      const rows =
        search === undefined
          ? []
          : await readAll(search.items, {
              ...matchedLinesQuery(criteria),
              query: search.query,
              sort: criteria.sort,
            });
      response
        .type('text/csv; charset=utf-8')
        .attachment('moodle-users.csv')
        .send(toCsv(exportRows.parse(withMatchedLines(rows, criteria))));
    } catch (error) {
      next(error);
    }
  });
});
