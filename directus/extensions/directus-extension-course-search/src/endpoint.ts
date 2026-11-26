import type { Accountability, Filter, Query } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import { countOf, readPage } from './count-order.js';
import {
  criteriaProblem,
  criteriaSchema,
  invalidCriteria,
  type MatchMode,
  matchModes,
} from './criteria.js';
import { filterPathProblem, relationalDepthLimit } from './filter-paths.js';
import {
  countedCourseCondition,
  countedForAny,
  courseCondition,
  splitHistory,
} from './history.js';
import { nameMatcher, nameWords } from './name-match.js';

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

// The users a name query picks, or undefined when it names no word. The
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
      await read({ fields: ['id', 'Name'], limit: -1, offset, sort: ['id'] }),
    );
    if (rows.length === 0) return ids;
    for (const row of rows) if (matches(row.Name)) ids.push(row.id);
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

  router.post('/search', async (request, response, next) => {
    try {
      const parsed = criteriaSchema.safeParse(request.body);
      if (!parsed.success) {
        response
          .status(400)
          .json(errorBody('INVALID_PAYLOAD', criteriaProblem(parsed.error)));
        return;
      }
      // A filter path that names more fields than REST allows is refused
      // like an unsupported filter, with its own reason.
      const pathProblem = filterPathProblem(parsed.data.filter, maxDepth);
      if (pathProblem !== undefined) {
        response
          .status(400)
          .json(
            errorBody(
              'INVALID_PAYLOAD',
              invalidCriteria('filter', pathProblem),
            ),
          );
        return;
      }
      const criteria = parsed.data;
      const items = new services.ItemsService('moodle_users', {
        accountability: request.accountability,
        schema: await getSchema(),
      });
      const ids = await nameMatchIds(
        (nameQuery) => items.readByQuery(nameQuery),
        criteria.name,
      );
      if (ids?.length === 0) {
        response.json({ data: [], total: 0 });
        return;
      }
      const query = buildSearchQuery(criteria, ids);
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
});
