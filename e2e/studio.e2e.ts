import { type APIRequestContext, test as base, expect } from '@playwright/test';
import { z } from 'zod';

// Smoke tests of the Studio side of the extensions on a disposable
// Directus that setup has installed: the course-history search (layout,
// course pickers and results) and the Data operations dashboard panels
// render, work and throw nothing. Run by `npm run test:e2e`.

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);

const targetOf = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const url = environment['DIRECTUS_E2E_URL'];
  const email = environment['DIRECTUS_E2E_EMAIL'];
  const password = environment['DIRECTUS_E2E_PASSWORD'];
  const token = environment['DIRECTUS_E2E_TOKEN'];
  if (!url || !email || !password || !token) {
    throw new Error(
      'Set DIRECTUS_E2E_URL, _EMAIL, _PASSWORD and _TOKEN for a disposable Directus',
    );
  }
  if (!loopbackHosts.has(new URL(url).hostname)) {
    throw new Error('DIRECTUS_E2E_URL must be loopback-only');
  }
  return { email, password, token };
};

const target = targetOf(process.env);
const admin = { Authorization: `Bearer ${target.token}` };
const idRows = z.object({
  data: z.array(z.object({ id: z.union([z.number(), z.string()]) })),
});

// The id of the first row a read answers.
const firstId = async (request: APIRequestContext, path: string) => {
  const response = await request.get(path, { headers: admin });
  expect(response.ok()).toBe(true);
  const [row] = idRows.parse(await response.json()).data;
  if (row === undefined) {
    throw new Error(`${path} answered no row`);
  }
  return String(row.id);
};

// Every test runs signed in (a session cookie, as Studio uses) and fails on
// any uncaught error of the page.
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });
      const login = await page.request.post('/auth/login', {
        data: {
          email: target.email,
          mode: 'session',
          password: target.password,
        },
      });
      expect(login.ok()).toBe(true);
      await use(errors);
      expect(errors).toStrictEqual([]);
    },
    { auto: true },
  ],
});

test.beforeAll(async ({ request }) => {
  const response = await request.post('/items/moodle_users', {
    data: [
      {
        Courses: 'Synthetic Algebra\nSynthetic Physics',
        'Courses Count': 2,
        Name: 'E2E Both',
      },
      { Courses: 'Synthetic Algebra', 'Courses Count': 1, Name: 'E2E Algebra' },
      { Courses: 'Synthetic Physics', 'Courses Count': 1, Name: 'E2E Physics' },
    ],
    headers: admin,
  });
  expect(response.ok()).toBe(true);
});

test('the course-history search finds users by the courses they took', async ({
  page,
}) => {
  const bookmark = await firstId(
    page.request,
    '/presets?fields=id&filter[bookmark][_eq]=Search&filter[collection][_eq]=moodle_users',
  );
  await page.goto(`/admin/content/moodle_users?bookmark=${bookmark}`);
  await expect(
    page.getByRole('heading', { name: 'Course history search' }),
  ).toBeVisible();

  const include = page.getByRole('combobox').first();
  await include.click();
  await include.fill('Synthetic Algebra');
  await page.getByRole('option', { name: 'Synthetic Algebra' }).click();
  const remove = page.getByRole('button', { name: 'Remove Synthetic Algebra' });
  await expect(remove).toBeVisible();

  const results = page.getByRole('region', { name: 'Matching users' });
  await expect(results.getByText('E2E Both')).toBeVisible();
  await expect(results.getByText('E2E Algebra')).toBeVisible();
  await expect(results.getByText('E2E Physics')).toHaveCount(0);

  await remove.click();
  await expect(remove).toHaveCount(0);
});

test('the Data operations dashboard shows its run and status panels', async ({
  page,
}) => {
  const dashboard = await firstId(
    page.request,
    '/dashboards?fields=id&filter[name][_eq]=Data%20operations',
  );
  await page.goto(`/admin/insights/${dashboard}`);
  await expect(page.getByRole('button', { name: 'Run' }).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh the data status' }).first(),
  ).toBeVisible();
  for (const panel of ['Recalculate', 'Calculations', 'Published keys']) {
    await expect(page.getByText(panel).first()).toBeVisible();
  }
});
