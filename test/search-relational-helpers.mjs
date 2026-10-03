import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { snapshotFields } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { get, remove } from './relational/history-index-helpers.mjs';
import {
  runImport,
  uploadCsv,
  writeSnapshot,
} from './relational/snapshot-import-helpers.mjs';
import { searchResponse } from './search-integration-helpers.mjs';

// The fixture side of test/search-relational.integration.mjs: synthetic
// Moodle snapshots (invented names, `.example` addresses and profile
// hosts), imported through the installed "Data / Import Moodle snapshot"
// Flow, and requests to the Search endpoints as a given caller. Nothing
// here prints a row, a token or a password.

const endpoint = '/finki-hub-course-history';
export const tieName = 'Tie Searcher';
export const tieRows = 52;

const profile = (kind, name) =>
  `https://profiles.example/${kind}/${encodeURIComponent(name)}`;

// A snapshot row from its named values, in snapshotFields order; every
// other scraper field stays empty.
const snapshotRow = (values) =>
  snapshotFields.map((field) => values[field] ?? null);

const person = (Name, Courses, count) => ({
  Courses,
  'Courses Count': count,
  Name,
});

// The rows every snapshot shares: exact LF/CRLF boundaries, a LIKE
// wildcard, a null history, and 52 users who tie on name and history size
// (so only the id orders them).
const commonRows = (offset) => [
  person('Boundary LF', 'Exact LF\nExclude LF', 2),
  person('Boundary CRLF', 'Exact CRLF\r\nExact LF', 2),
  person('Boundary Starts', 'Exact LF\nAnother', 2),
  person('Boundary Ends', 'Another\r\nExact LF', 2),
  person('Boundary Embedded', 'Another\nExact LF\r\nThird', 4),
  person('Boundary Near', 'Exact LFx', 1),
  person('Boundary Underscore', 'Under_score\nAnother', 2),
  person('Boundary Wildcard', 'UnderXscore', 1),
  person('Boundary Null', null, 0),
  person('Ignored Holder', 'Ignored Entry', 1),
  ...Array.from({ length: tieRows }, (_, index) => ({
    ...person(tieName, 'Tie Entry', 3),
    Mail: `tie-${String(index + offset)}@search.example`,
  })),
];

// The first snapshot: both profile links, a mapped line and the most
// courses on one user.
export const firstSnapshot = [
  ...commonRows(0),
  {
    ...person('Profile Both', 'Profile Entry', 1),
    Profile_new: profile('new', 'both-a'),
    Profile_old: profile('old', 'both-a'),
  },
  {
    ...person('Profile Old Only', 'Profile Entry', 1),
    Profile_old: profile('old', 'only-a'),
  },
  person('Mapped Holder', 'Mapped Entry\nAnother', 9),
];

// The replacement: new links for the same person, the mapped line and
// its holder gone, a newcomer with a line the index has not seen yet and
// a different user with the most courses.
export const secondSnapshot = [
  ...commonRows(100),
  {
    ...person('Profile Both', 'Profile Entry', 1),
    Profile_new: profile('new', 'both-b'),
    Profile_old: profile('old', 'both-b'),
  },
  {
    ...person('Profile New Only', 'Profile Entry', 1),
    Profile_new: profile('new', 'only-b'),
  },
  person('Replacement Newcomer', 'Fresh Entry\nAnother', 12),
];

// Writes, uploads and imports one snapshot through the installed Flow;
// answers the Flow's summary. The uploaded CSV and the backup the
// promotion keeps are removed by `removeFiles`.
export const importSnapshot = async (target, state, { rows, title }) => {
  if (state.dir === undefined) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'search-relational-'));
    Object.assign(state, { dir });
  }
  const file = path.join(state.dir, `${title}.csv`);
  await writeSnapshot(file, rows.map(snapshotRow));
  const id = await uploadCsv(target, { file, state, title });
  const run = await runImport(target, { confirm_replace: true, file: id });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.state, 'completed');
  assert.equal(run.body.rows, rows.length);
  return run.body;
};

// The ids of every file present now, to tell the run's own files apart.
export const fileIds = async (target) => {
  const files = await get(target, '/files?fields=id&limit=-1');
  return new Set(files.map(({ id }) => id));
};

// Removes the files the run created (the uploads and the promotion
// backups) and the local CSV directory.
export const removeFiles = async (target, state, before) => {
  const present = await fileIds(target);
  for (const id of present) {
    if (!before.has(id)) await remove(target, `/files/${id}`);
  }
  if (state.dir !== undefined)
    await rm(state.dir, { force: true, recursive: true });
};

// POST /search as a caller: { status, body }.
export const searchAs = async (target, token, criteria) => {
  const response = await searchResponse(target, token, {
    exclude: [],
    include: [],
    page: 1,
    sort: 'Name',
    ...criteria,
  });
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

// GET /options as a caller: { status, body }.
export const optionsAs = async (target, token) => {
  const response = await fetch(new URL(`${endpoint}/options`, target.base), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  return { body: await response.json(), status: response.status };
};

export const names = (answer) => answer.body.data.map(({ Name }) => Name);
