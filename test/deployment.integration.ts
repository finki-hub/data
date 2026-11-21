import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';

import { directusDefaultPrompt, systemPrompt } from '../src/ai-prompt.js';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

// End to end against a disposable Directus that `npm run setup` has just
// installed (CI: the development compose project): the public API reads
// what src/data-model/access.ts declares and nothing else, and /catalog
// serves the courses from the live rows. The target must be on
// loopback and is written to, so it is named explicitly and never a
// project holding data.

const uploaded = { scheduleFileId: '' };

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);

// The explicit, loopback-only target, refused before anything is sent.
const targetOf = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const url = environment['DIRECTUS_INTEGRATION_URL'];
  const adminToken = environment['DIRECTUS_INTEGRATION_TOKEN'];
  if (
    url === undefined ||
    url === '' ||
    adminToken === undefined ||
    adminToken === ''
  ) {
    throw new Error(
      'Set DIRECTUS_INTEGRATION_URL and DIRECTUS_INTEGRATION_TOKEN to a disposable Directus',
    );
  }
  const target = new URL(url);
  if (!loopbackHosts.has(target.hostname)) {
    throw new Error('DIRECTUS_INTEGRATION_URL must be loopback-only');
  }
  return { base: target, token: adminToken };
};

const { base, token } = targetOf(process.env);

const call = (path: string, init: FetchInit = {}, auth = true) => {
  const headers = new Headers(init.headers);
  if (auth) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(new URL(path, base), {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
};

const envelope = z.object({ data: z.unknown() });

const data = async (path: string, init?: FetchInit): Promise<unknown> => {
  const response = await call(path, init);
  const text = await response.text();
  assert.ok(
    response.ok,
    `${path} answered ${String(response.status)}: ${text}`,
  );
  return text === '' ? null : envelope.parse(JSON.parse(text)).data;
};

const post = (path: string, body: unknown) =>
  data(path, { body: JSON.stringify(body), method: 'POST' });

const created = z.object({ id: z.union([z.number(), z.string()]) });

const schedule = Buffer.from('synthetic schedule\n', 'utf8');

before(async () => {
  await post('/items/rooms', {
    capacity: 0,
    location: 'Synthetic building',
    name: 'Synthetic room',
    type: 'lab',
  });
  await post('/items/staff', {
    active: true,
    email: 'synthetic@example.com',
    name: 'Synthetic Staff',
    position: 'professor',
    title: 'Dr.',
  });
  await post('/items/anto_quotes', [
    { quote: 'Synthetic quote one' },
    { quote: 'Synthetic quote two' },
  ]);
  const folder = created.parse(
    await post('/folders', { name: 'Exam sessions' }),
  );
  const form = new FormData();
  form.append('title', 'Synthetic session');
  form.append('folder', String(folder.id));
  form.append(
    'file',
    new Blob([schedule], { type: 'application/pdf' }),
    'synthetic_session.pdf',
  );
  const file = created.parse(
    await data('/files', { body: form, method: 'POST' }),
  );
  uploaded.scheduleFileId = String(file.id);
  await post('/items/exam_sessions', [
    { file: file.id, name: '2099/2100 Јуни' },
    { file: file.id, name: '2099/2100 Септември' },
  ]);
  const [member] = z.array(created).parse(
    await post('/items/students', [
      {
        index_number: '990001',
        name: 'Council Member',
        source_group: 'synthetic',
      },
      {
        index_number: '990002',
        name: 'Private Student',
        source_group: 'synthetic',
      },
    ]),
  );
  assert.ok(member);
  await post('/items/student_council', {
    index_number: '990001',
    position: 'member',
    student: member.id,
    year: 2_099,
  });
});

const anonymous = async (path: string) => {
  const response = await call(path, {}, false);
  return { body: await response.text(), status: response.status };
};

test('anonymous callers read the public collections', async () => {
  for (const collection of [
    'courses',
    'rooms',
    'staff',
    'anto_quotes',
    'exam_sessions',
  ]) {
    const { status } = await anonymous(`/items/${collection}?limit=1`);
    assert.equal(status, 200, collection);
  }
});

test('the Moodle users and the operations stay private', async () => {
  for (const collection of ['moodle_users', 'data_operations']) {
    const { status } = await anonymous(`/items/${collection}?limit=1`);
    assert.equal(status, 403, collection);
  }
});

const publicStudents = z.object({
  data: z.array(z.looseObject({ name: z.string() })),
});

test('students are public only as council members, by name only', async () => {
  const { body, status } = await anonymous(
    '/items/students?fields=*&filter[name][_in]=Council Member,Private Student',
  );
  assert.equal(status, 200);
  const rows = publicStudents.parse(JSON.parse(body)).data;
  assert.deepEqual(
    rows.map(({ name }) => name),
    ['Council Member'],
  );
  assert.equal(rows[0]?.['source_group'], undefined);
  assert.equal(rows[0]?.['index_number'], undefined);

  const council = await anonymous(
    '/items/student_council?fields=*&filter[year][_eq]=2099',
  );
  assert.equal(council.status, 200);
  assert.ok(!council.body.includes('990001'));
});

const catalogCourses = '/catalog/courses.json';

test('/catalog serves the courses to a browser frontend', async () => {
  const response = await call(
    catalogCourses,
    { headers: { Origin: 'https://predmeti.finki-hub.com' } },
    false,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.ok(Array.isArray(await response.json()));
  const unknown = await call('/catalog/unknown.json', {}, false);
  assert.equal(unknown.status, 404);
});

test('/catalog answers an unchanged file with 304', async () => {
  const first = await call(catalogCourses, {}, false);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await call(
    catalogCourses,
    { headers: { 'If-None-Match': etag } },
    false,
  );
  assert.equal(again.status, 304);
});

test('an exam schedule is public byte for byte', async () => {
  const response = await call(
    `/assets/${uploaded.scheduleFileId}/synthetic_session.pdf`,
    {},
    false,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), schedule);
});

const settingsPrompt = z.object({
  data: z.object({ ai_system_prompt: z.string().nullable() }),
});

test('setup stores the AI assistant system prompt', async () => {
  const response = await call('/settings?fields=ai_system_prompt');
  const stored = settingsPrompt.parse(await response.json()).data;
  assert.equal(stored.ai_system_prompt, systemPrompt);
});

// The repository keeps a copy of Directus's own system prompt, which the
// custom one replaces; a Directus release that changes it fails here, so
// the copy is refreshed. Needs the compose project (CI).
const composeService = process.env['DIRECTUS_INTEGRATION_COMPOSE_SERVICE'];
const defaultPromptPath =
  '/directus/node_modules/@directus/api/dist/ai/chat/constants/system-prompt.js';
const promptLiteral = /const SYSTEM_PROMPT = `(?<prompt>[\s\S]*?)`;/u;

test(
  "the stored copy of Directus's default prompt matches the running Directus",
  { skip: composeService === undefined },
  async () => {
    const { stdout } = await promisify(execFile)('docker', [
      'compose',
      'exec',
      '-T',
      composeService ?? '',
      'cat',
      defaultPromptPath,
    ]);
    const running = promptLiteral
      .exec(stdout)
      ?.groups?.['prompt']?.replaceAll('\\`', '`')
      .trim();
    assert.equal(running, directusDefaultPrompt);
  },
);
