import type { Accountability, Filter } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import { countOf, readPage } from './count-order.js';
import {
  criteriaProblem,
  criteriaSchema,
  invalidCriteria,
} from './criteria.js';
import { filterPathProblem, relationalDepthLimit } from './filter-paths.js';
import { courseCondition, splitHistory } from './history.js';

const macedonianCollator = new Intl.Collator('mk');

declare global {
  namespace Express {
    interface Request {
      accountability?: Accountability;
    }
  }
}

const historyRows = z.array(z.object({ Courses: z.string().nullish() }));
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
  readonly search?: null | string | undefined;
};

// Directus's own error body: one error, its code in `extensions`.
const errorBody = (code: string, message: string) => ({
  errors: [{ extensions: { code }, message }],
});

export const buildSearchQuery = (
  criteria: SearchCriteria,
): CourseSearchQuery => ({
  filter: {
    _and: [
      ...(criteria.filter ? [criteria.filter] : []),
      ...criteria.include.map((course) => courseCondition(course)),
      ...criteria.exclude.map((course) => courseCondition(course, true)),
    ],
  },
  ...(criteria.search && { search: criteria.search }),
});

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
      const items = new services.ItemsService('moodle_users', {
        accountability: request.accountability,
        schema: await getSchema(),
      });
      const courses = new Set<string>();
      for (let offset = 0; ; offset += 500) {
        const rows = historyRows.parse(
          await items.readByQuery({
            fields: ['Courses'],
            limit: 500,
            offset,
            sort: ['id'],
          }),
        );
        for (const row of rows)
          for (const course of splitHistory(row.Courses)) courses.add(course);
        if (rows.length < 500) break;
      }
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
      const schema = await getSchema();
      // A filter path that passes a collection twice or names more fields
      // than REST allows is refused like an unsupported filter, with its
      // own reason.
      const pathProblem = filterPathProblem(parsed.data.filter, {
        maxDepth,
        relations: schema.relations,
        root: 'moodle_users',
      });
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
        schema,
      });
      const query = buildSearchQuery(criteria);
      const [data, counts] = await Promise.all([
        readPage(items, {
          fields: resultFields,
          page: criteria.page,
          query,
          sort: criteria.sort,
        }),
        items.readByQuery({ ...query, aggregate: { count: ['id'] } }),
      ]);
      response.json({ data, total: countOf(counts) });
    } catch (error) {
      next(error);
    }
  });
});
