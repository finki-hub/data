import { defineEndpoint } from '@directus/extensions-sdk';
import type { Accountability, Filter } from '@directus/types';
import { z } from 'zod';

import { courseCondition, splitHistory } from './history.js';
import { nativeFilter } from './native-filter.js';

declare global {
  namespace Express {
    interface Request {
      accountability?: Accountability;
    }
  }
}

const criteriaSchema = z.object({
  include: z.array(z.string().min(1).max(2000)).max(20),
  exclude: z.array(z.string().min(1).max(2000)).max(20),
  search: z.string().max(1000).nullish(),
  filter: nativeFilter.nullish(),
  page: z.number().int().min(1),
  sort: z.enum(['Name', 'Courses Count', '-Courses Count']).default('Name'),
});
const historyRows = z.array(z.object({ Courses: z.string().nullish() }));
const countRows = z.array(z.object({ count: z.object({ id: z.coerce.number().int().min(0) }) }));

export default defineEndpoint((router, { services, getSchema }) => {
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!request.accountability?.user) {
      response.status(403).json({ errors: [{ message: 'Sign in to search course histories.' }] });
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
        const rows = historyRows.parse(await items.readByQuery({
          fields: ['Courses'], sort: ['id'], limit: 500, offset,
        }));
        for (const row of rows) for (const course of splitHistory(row.Courses)) courses.add(course);
        if (rows.length < 500) break;
      }
      response.json({ data: [...courses].sort((left, right) => left.localeCompare(right, 'mk')) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/search', async (request, response, next) => {
    const parsed = criteriaSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ errors: [{ message: 'Choose up to 20 courses in each group and a valid page.' }] });
      return;
    }
    try {
      const criteria = parsed.data;
      const items = new services.ItemsService('moodle_users', {
        accountability: request.accountability,
        schema: await getSchema(),
      });
      const filter: Filter = { _and: [
        ...(criteria.filter ? [criteria.filter] : []),
        ...criteria.include.map((course) => courseCondition(course)),
        ...criteria.exclude.map((course) => courseCondition(course, true)),
      ] };
      const query = { filter, ...(criteria.search ? { search: criteria.search } : {}) };
      const [data, counts] = await Promise.all([
        items.readByQuery({
          ...query,
          fields: ['id', 'Name', 'Mail', 'Profile_new', 'Profile_old', 'Courses', 'Courses Count'],
          sort: criteria.sort === 'Name' ? ['Name', 'id'] : [criteria.sort, 'Name', 'id'],
          limit: 50, offset: (criteria.page - 1) * 50,
        }),
        items.readByQuery({ ...query, aggregate: { count: ['id'] } }),
      ]);
      response.json({ data, total: countRows.parse(counts)[0]?.count.id ?? 0 });
    } catch (error) {
      next(error);
    }
  });
});
