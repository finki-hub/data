import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, openAsBlob } from 'node:fs';

import { snapshotFields } from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { snapshotFolder } from '../../src/flows/snapshot-folder.js';
import { snapshotFlowId } from '../../src/flows/snapshot-import.js';
import { json, read, request } from './data-model-helpers.mjs';

// Constants, the synthetic snapshot generator and the request helpers of
// the snapshot import fixture suite (snapshot-import.integration.mjs).
// Every row is invented: synthetic names, `.example` addresses, generated
// course labels.

const flowPath = `/flows/trigger/${snapshotFlowId}`;
export const snapshotPath = '/finki-hub-data-operations/snapshot';
export const statusPath = '/finki-hub-data-operations/status';
export const probeImportFlowId = '9e4d826c-5b1a-4c0e-8f2d-000000001001';
export const probePromoteFlowId = '9e4d826c-5b1a-4c0e-8f2d-000000001003';
export const probeStagingFlowId = '9e4d826c-5b1a-4c0e-8f2d-000000001005';
const readerPolicyPrefix = 'Synthetic snapshot reader ';
export const backupTitlePrefix = 'moodle-users-backup-';
const labelCount = 5_000;
export const longLineRows = [29_000, 29_998];

const courseVariants = [
  'Основи на програмирање',
  'Дизајн на софтвер',
  '数据结构',
  'Networks 🌐',
  'Calculus',
];

const courseLabel = (index) =>
  `Synthetic Course ${String(index).padStart(4, '0')} - ${courseVariants[index % courseVariants.length]}`;

const names = [
  (index) => `Synthetic Student ${index}`,
  (index) => `Синтетички Студент ${index}`,
  (index) => `合成学生 ${index}`,
  (index) => `Synthetic 😀 Student ${index}`,
];

const longLine = (index) =>
  index % 2 === 0
    ? `${'Ж'.repeat(20_000)}${'漢'.repeat(10_000)}${'😀'.repeat(5_000)}`
    : `${'😀'.repeat(10_000)}${'Ж'.repeat(20_000)}`;

const history = (index, offset) => {
  if (longLineRows.includes(index)) return longLine(index);
  const lineCount = index % 1_000 === 500 ? 300 : 1 + (index % 6);
  const lines = Array.from({ length: lineCount }, (_, line) =>
    courseLabel((index * 7 + offset + line * 131) % labelCount),
  );
  if (index % 13 === 0) lines.push(lines[0]);
  if (index % 17 === 0) lines.push(`Unlisted Synthetic Elective ${index}`);
  return lines.join(index % 11 === 0 ? '\r\n' : '\n');
};

const special = (index) => {
  switch (index % 500) {
    case 7:
      return '{"note": "json-like"}';
    case 8:
      return '[Skopje]';
    case 9:
      return 'true';
    case 10:
      return 'null';
    default:
      return null;
  }
};

const ids = (index, offset) => {
  const old = offset + 100_000 + index;
  const fresh = offset + 500_000 + index;
  return [
    [old, fresh],
    [old, null],
    [null, fresh],
    [null, null],
  ][index % 4];
};

// One synthetic snapshot row, in snapshotFields order, deterministic in
// its index and offset (a different offset yields a different snapshot).
const syntheticRow = (index, offset = 0) => {
  const [idOld, idNew] = ids(index, offset);
  const lines = history(index, offset);
  const values = {
    City_new:
      index % 9 === 0 ? '  padded  ' : ['Скопје', 'Битола', null][index % 3],
    Country_new: index % 3 === 0 ? null : 'MK',
    Courses: index % 400 === 0 ? null : lines,
    'Courses Count': index % 50 === 0 ? null : lines.split('\n').length,
    Description_new: special(index),
    ID_new: idNew,
    ID_old: idOld,
    'Last Access_new': `${index % 30} days ${index % 24} hours`,
    Mail: index % 4 === 0 ? null : `student${offset + index}@snapshot.example`,
    Name:
      index % 97 === 0
        ? `"Quoted" Student, ${index}`
        : names[index % names.length](index + offset),
    Profile_new: index % 250 === 3 ? 'line one\r\nline two' : null,
    Timezone_new: 'Europe/Skopje',
    Web_old: index % 333 === 0 ? '' : null,
  };
  return snapshotFields.map((field) => values[field] ?? null);
};

export const syntheticRows = (length, offset = 0) =>
  Array.from({ length }, (_, index) => syntheticRow(index, offset));

const needsQuotes = /[\n\r",]/u;

// A cell as a spreadsheet export writes it: quoted only when needed, an
// empty text quoted so it stays distinct from an absent value.
const cell = (value) => {
  if (value === null) return '';
  const text = String(value);
  return text === '' || needsQuotes.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
};

// The header in reverse contract order: the import maps columns by name.
const csvOrder = snapshotFields.map(
  (_, index) => snapshotFields.length - 1 - index,
);

export const csvRecord = (values) =>
  `${csvOrder.map((index) => cell(values[index] ?? null)).join(',')}\n`;

export const csvHeader = csvRecord(snapshotFields);

// Streams the rows into a file, 1,000 lines per write; `raw` replaces the
// line of one row with literal text (for a malformed late row).
export const writeSnapshot = async (file, rows, raw = new Map()) => {
  const stream = createWriteStream(file, { encoding: 'utf8' });
  stream.write(csvHeader);
  for (let start = 0; start < rows.length; start += 1_000) {
    const chunk = rows
      .slice(start, start + 1_000)
      .map((row, offset) => raw.get(start + offset) ?? csvRecord(row))
      .join('');
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');
};

const longTimeout = 900_000;

// A request with a long timeout (a full snapshot run answers only once
// it committed); `init.token` overrides the administrator token.
export const call = async (target, path, init = {}) => {
  const { token = target.token, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(new URL(path, target.base), {
    ...rest,
    headers,
    signal: AbortSignal.timeout(longTimeout),
  });
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

export const get = async (target, path) => {
  const outcome = await call(target, path);
  assert.equal(outcome.status, 200, `${path}: ${JSON.stringify(outcome.body)}`);
  return outcome.body.data;
};

const post = async (target, path, body) =>
  read(await request(target, path, json('POST', body, target.token)), 200);

const remove = async (target, path) =>
  read(
    await request(target, path, { method: 'DELETE', token: target.token }),
    204,
  );

// Deletes what a run may have created; an item that is already gone
// (Directus answers 403 or 404 for a missing id) is fine. Returns a
// description of any other outcome, for the cleanup to report at the end.
export const removeIfPresent = async (target, path) => {
  const outcome = await call(target, path, { method: 'DELETE' });
  return [204, 403, 404].includes(outcome.status)
    ? null
    : `${path} answered ${outcome.status}`;
};

export const count = async (target, collection) => {
  const rows = await get(target, `/items/${collection}?aggregate[count]=*`);
  return Number(rows[0]?.count ?? 0);
};

export const codeOf = (body) => body?.errors?.[0]?.extensions?.code ?? null;
export const messageOf = (body) => body?.errors?.[0]?.message ?? '';

// Uploads a private CSV through the standard Files API (local storage,
// multipart, never a JSON body) into the snapshot folder, or elsewhere
// with `folder: null`, and returns its id.
export const uploadCsv = async (
  target,
  { file, folder = snapshotFolder.id, state, title },
) => {
  const form = new FormData();
  form.append('title', title);
  if (folder !== null) form.append('folder', folder);
  form.append(
    'file',
    await openAsBlob(file, { type: 'text/csv' }),
    `${title}.csv`,
  );
  const outcome = await call(target, '/files', { body: form, method: 'POST' });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  state.files.push(outcome.body.data.id);
  return outcome.body.data.id;
};

const trigger = (target, path, { body, token }) =>
  call(target, path, {
    body: JSON.stringify({ collection: 'data_operations', ...body }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    token,
  });

// Runs the installed "Data / Import Moodle snapshot" Flow like Studio.
export const runImport = (target, body, token = target.token) =>
  trigger(target, flowPath, { body, token });

// Compares stored rows with the generated ones value by value; a
// mismatch names the row and the field, never a value.
export const assertRawRows = (stored, expected, label) => {
  for (const [index, row] of expected.entries()) {
    for (const [position, field] of snapshotFields.entries()) {
      const want = row[position] ?? null;
      const got = stored[index]?.[field] ?? null;
      assert.ok(
        got === want,
        `${label}: row ${index} field ${field} differs from the generated value`,
      );
    }
  }
};

export const fieldsQuery = snapshotFields
  .map((field) => encodeURIComponent(field))
  .join(',');

// A manual probe Flow on data_operations that runs one operation with the
// options taken from the request body, without the template's
// administrator gate, so the operations' own checks can be reached.
export const installProbe = async (target, { id, operation, options }) => {
  await post(target, '/flows', {
    accountability: 'activity',
    description:
      'Synthetic snapshot probe; removed by the suite that installs it.',
    icon: 'science',
    id,
    name: `Synthetic snapshot probe ${id.slice(-4)}`,
    options: {
      async: false,
      collections: ['data_operations', 'moodle_import_rows'],
      error_on_reject: true,
      requireSelection: false,
    },
    status: 'inactive',
    trigger: 'manual',
  });
  const operationId = `${id.slice(0, -1)}${Number(id.at(-1)) + 1}`;
  await post(target, '/operations', {
    flow: id,
    id: operationId,
    key: 'probe',
    name: 'Probe',
    options,
    position_x: 19,
    position_y: 1,
    type: operation,
  });
  await read(
    await request(
      target,
      `/flows/${id}`,
      json('PATCH', { operation: operationId, status: 'active' }, target.token),
    ),
    200,
  );
};

// Makes a moodle_users column NOT NULL, or nullable again, through the
// Directus fields API (the fixture's schema is the suite's own: the model
// teardown drops it either way).
export const setRequired = async (target, field, required) => {
  const outcome = await call(target, `/fields/moodle_users/${field}`, {
    body: JSON.stringify({ schema: { is_nullable: !required } }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
};

export const triggerProbe = (target, id, { body, token = target.token }) =>
  trigger(target, `/flows/trigger/${id}`, { body, token });

// A non-administrator who may read data_operations (enough to trigger a
// manual Flow on it): a policy with that one permission and a user
// without an address, both removed afterwards.
export const withReader = async (target, body) => {
  const policy = await post(target, '/policies', {
    admin_access: false,
    app_access: false,
    icon: 'lock',
    name: `${readerPolicyPrefix}${randomUUID()}`,
  });
  let user = null;
  try {
    await post(target, '/permissions', {
      action: 'read',
      collection: 'data_operations',
      fields: ['id'],
      permissions: {},
      policy: policy.data.id,
    });
    const token = `synthetic-${randomUUID()}`;
    user = await post(target, '/users', {
      first_name: 'Synthetic',
      last_name: 'Snapshot Reader',
      policies: [{ policy: policy.data.id }],
      status: 'active',
      token,
    });
    await body(token);
  } finally {
    if (user !== null) await remove(target, `/users/${user.data.id}`);
    await remove(target, `/policies/${policy.data.id}`);
  }
};
