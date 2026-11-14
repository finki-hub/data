import assert from 'node:assert/strict';
import { before, test } from 'node:test';

// End to end against a disposable Directus that `npm run setup` has just
// installed (CI: the development compose project): the public API reads
// what src/data-model/access.ts declares and nothing else, and /legacy
// serves the old bucket's files from the live rows. The target must be on
// loopback and is written to, so it is named explicitly and never a
// project holding data.

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);

// The explicit, loopback-only target, refused before anything is sent.
const targetOf = (environment) => {
  const url = environment.DIRECTUS_INTEGRATION_URL;
  const adminToken = environment.DIRECTUS_INTEGRATION_TOKEN;
  if (!url || !adminToken) {
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

const call = (path, init = {}, auth = true) => {
  const headers = new Headers(init.headers);
  if (auth) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(new URL(path, base), {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
};

const data = async (path, init) => {
  const response = await call(path, init);
  const text = await response.text();
  assert.ok(response.ok, `${path} answered ${response.status}: ${text}`);
  return text === '' ? null : JSON.parse(text).data;
};

const post = (path, body) =>
  data(path, { body: JSON.stringify(body), method: 'POST' });

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
  const form = new FormData();
  form.append('title', 'Synthetic session');
  form.append(
    'file',
    new Blob([schedule], { type: 'application/pdf' }),
    'synthetic_session.pdf',
  );
  const file = await data('/files', { body: form, method: 'POST' });
  await post('/items/exam_sessions', [
    { file: file.id, name: '2099/2100 Јуни' },
    { file: file.id, name: '2099/2100 Септември' },
  ]);
  const [member, other] = await post('/items/students', [
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
  ]);
  assert.ok(other);
  await post('/items/student_council', {
    index_number: '990001',
    position: 'member',
    student: member.id,
    year: 2_099,
  });
});

const anonymous = async (path) => {
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

test('students are public only as council members, without their group', async () => {
  const { body, status } = await anonymous(
    '/items/students?fields=*&filter[index_number][_starts_with]=9900',
  );
  assert.equal(status, 200);
  const rows = JSON.parse(body).data;
  assert.deepEqual(
    rows.map(({ index_number }) => index_number),
    ['990001'],
  );
  assert.equal(rows[0].source_group, undefined);
});

const legacy = async (file) => {
  // As a browser frontend asks for it.
  const response = await call(
    `/legacy/${file}`,
    { headers: { Origin: 'https://courses.finki-hub.com' } },
    false,
  );
  assert.equal(response.status, 200, `/legacy/${file}`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  return response;
};

const legacyJson = async (file) => {
  const response = await legacy(file);
  return response.json();
};

test('/legacy serves the old bucket files from the live rows', async () => {
  const rooms = await legacyJson('rooms.json');
  assert.deepEqual(rooms, [
    {
      capacity: '0',
      location: 'Synthetic building',
      name: 'Synthetic room',
      type: 'lab',
    },
  ]);
  const staff = await legacyJson('staff.json');
  assert.equal(staff.length, 1);
  assert.equal(staff[0].name, 'Synthetic Staff');
  assert.deepEqual(await legacyJson('anto.json'), [
    'Synthetic quote one',
    'Synthetic quote two',
  ]);
  assert.deepEqual(await legacyJson('sessions.json'), {
    '2099/2100 Јуни': 'synthetic_session.pdf',
    '2099/2100 Септември': 'synthetic_session.pdf',
  });
  assert.ok(Array.isArray(await legacyJson('courses.json')));
});

test('/legacy serves a session schedule byte for byte, and 404 for others', async () => {
  const response = await legacy('sessions/synthetic_session.pdf');
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), schedule);
  const missing = await call('/legacy/sessions/missing.pdf', {}, false);
  assert.equal(missing.status, 404);
  const unknown = await call('/legacy/unknown.json', {}, false);
  assert.equal(unknown.status, 404);
});

test('/legacy answers an unchanged file with 304', async () => {
  const first = await legacy('anto.json');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await call(
    '/legacy/anto.json',
    { headers: { 'If-None-Match': etag } },
    false,
  );
  assert.equal(again.status, 304);
});
