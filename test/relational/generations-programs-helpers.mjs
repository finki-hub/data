import assert from 'node:assert/strict';

import { exportDefinitions } from '../../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { errorCode, json, read, request } from './data-model-helpers.mjs';
import {
  engineFiles,
  prepare,
  restReader,
} from './export-projection-helpers.mjs';
import { get, post, remove } from './history-index-helpers.mjs';

// The rows and requests of the generations-programs fixture suite. Every
// row is invented; the new generation and its programs exist only here.

export const newGeneration = '2028';

// The id of a generation row of a code.
export const generationId = async (target, code) => {
  const [row] = await get(
    target,
    `/items/curriculum_generations?fields=id&filter[code][_eq]=${code}`,
  );
  assert.ok(row, `generation ${code} exists`);
  return row.id;
};

// A write the database or Directus must refuse with a 400; answers its code.
export const refusedWrite = async (target, { body, method, path }) =>
  errorCode(
    await read(
      await request(target, path, json(method, body, target.token)),
      400,
    ),
  );

// The rows a POST created.
const created = async (target, path, rows) => {
  const answer = await post(target, path, rows);
  return answer.data;
};

// Publish / Prepare public assets, which must answer: its digests by file.
export const preparedDigests = async (target) => {
  const run = await prepare(target);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return Object.fromEntries(
    run.body.files.map(({ filename, sha256 }) => [filename, sha256]),
  );
};

// The files the engine builds in this process over the live rows, parsed,
// by filename, and their digests (which equal the prepared ones).
export const liveFiles = async (target) => {
  const files = await engineFiles(exportDefinitions, restReader(target));
  return {
    digests: Object.fromEntries(
      files.map(({ filename, sha256 }) => [filename, sha256]),
    ),
    parsed: Object.fromEntries(
      files.map(({ body, filename }) => [filename, JSON.parse(body)]),
    ),
  };
};

// A public course row without the keys of the new generation.
export const withoutNewGeneration = (row) =>
  Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith(`${newGeneration}-`)),
  );

// The new generation and two programs, the second sorting first; an entry
// with a state in each, and a link of the course: nothing published.
export const addGeneration = async (target, course) => {
  const [generation] = await created(target, '/items/curriculum_generations', [
    {
      code: newGeneration,
      has_curriculum: true,
      label: `Curriculum ${newGeneration}`,
      sort: 4,
    },
  ]);
  const programs = await created(target, '/items/study_programs', [
    { code: 'ab', generation: generation.id, name: 'Synthetic AB', sort: 2 },
    { code: 'cd', generation: generation.id, name: 'Synthetic CD', sort: 1 },
  ]);
  const [entry] = await created(target, '/items/curriculum_entries', [
    {
      channel: false,
      code: 'SYN28-001',
      generation: generation.id,
      level: 1,
      name: 'Synthetic 2028 Entry',
      semester: 2,
    },
  ]);
  const states = await created(
    target,
    '/items/curriculum_entry_program_states',
    [
      { entry: entry.id, program: programs[0].id, state: 'A' },
      { entry: entry.id, program: programs[1].id, state: 'B' },
    ],
  );
  const [link] = await created(target, '/items/course_curricula', [
    {
      available: true,
      course,
      credits: 6,
      entry: entry.id,
      generation: generation.id,
      sort: 3,
    },
  ]);
  return {
    ab: programs[0].id,
    cd: programs[1].id,
    entry: entry.id,
    generation: generation.id,
    link: link.id,
    states: states.map(({ id }) => id),
  };
};

// Removes the new generation's rows, dependants first.
export const removeGeneration = async (target, rows) => {
  await remove(target, `/items/course_curricula/${rows.link}`);
  await remove(target, `/items/curriculum_entries/${rows.entry}`);
  for (const program of [rows.ab, rows.cd]) {
    await remove(target, `/items/study_programs/${program}`);
  }
  await remove(target, `/items/curriculum_generations/${rows.generation}`);
};
