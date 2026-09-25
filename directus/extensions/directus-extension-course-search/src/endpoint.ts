import type { Accountability, Filter } from '@directus/types';

import { defineEndpoint } from '@directus/extensions-sdk';
import { z } from 'zod';

import { filterPathProblem, relationalDepthLimit } from './filter-paths.js';
import { courseCondition, splitHistory } from './history.js';
import { nativeFilter } from './native-filter.js';

const macedonianCollator = new Intl.Collator('mk');

declare global {
  namespace Express {
    interface Request {
      accountability?: Accountability;
    }
  }
}

const criteriaSchema = z.object({
  exclude: z.array(z.string().min(1).max(2_000)).max(20),
  filter: nativeFilter.nullish(),
  include: z.array(z.string().min(1).max(2_000)).max(20),
  page: z.number().int().min(1),
  search: z.string().max(1_000).nullish(),
  sort: z.enum(['Name', 'Courses Count', '-Courses Count']).default('Name'),
});
const historyRows = z.array(z.object({ Courses: z.string().nullish() }));
const countRows = z.array(
  z.object({ count: z.object({ id: z.coerce.number().int().min(0) }) }),
);

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
        .json({ errors: [{ message: 'Sign in to search course histories.' }] });
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
      const schema = await getSchema();
      // A filter path that passes a collection twice or names more fields
      // than REST allows gets the same answer as an unsupported filter.
      if (
        !parsed.success ||
        filterPathProblem(parsed.data.filter, {
          maxDepth,
          relations: schema.relations,
          root: 'moodle_users',
        }) !== undefined
      ) {
        response.status(400).json({
          errors: [
            {
              message:
                'Choose up to 20 courses in each group and a valid page.',
            },
          ],
        });
        return;
      }
      const criteria = parsed.data;
      const items = new services.ItemsService('moodle_users', {
        accountability: request.accountability,
        schema,
      });
      const query = buildSearchQuery(criteria);
      const [data, counts] = await Promise.all([
        items.readByQuery({
          ...query,
          fields: [
            'id',
            'Name',
            'Mail',
            'Profile_new',
            'Profile_old',
            'Courses',
            'Courses Count',
          ],
          limit: 50,
          offset: (criteria.page - 1) * 50,
          sort:
            criteria.sort === 'Name'
              ? ['Name', 'id']
              : [criteria.sort, 'Name', 'id'],
        }),
        items.readByQuery({ ...query, aggregate: { count: ['id'] } }),
      ]);
      response.json({ data, total: countRows.parse(counts)[0]?.count.id ?? 0 });
    } catch (error) {
      next(error);
    }
  });
});
