import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { declaredFilenames as publicFiles } from '../../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { courses as coursesDefinition } from '../../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import { readQuery } from '../../directus/extensions/directus-extension-data-operations/src/exports/directus.js';
import { createDirectusRequest } from '../../src/directus-request.js';
import { runImportCli } from '../../src/import-run.js';
import { exitCodes } from '../../src/lifecycle.js';
import { asData, expectedData } from '../expected-exports.js';
import {
  syntheticPrograms,
  syntheticWorkbook,
} from '../fixtures/synthetic-workbook.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { parityDataset } from '../relational-export-helpers.js';
import { settle } from './automatic-processing-helpers.mjs';
import {
  pauseAutomaticProcessing,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import { readiness } from './export-projection-helpers.mjs';
import {
  addGeneration,
  generationId,
  liveFiles,
  newGeneration,
  preparedDigests,
  refusedWrite,
  removeGeneration,
  withoutNewGeneration,
} from './generations-programs-helpers.mjs';
import { get, patch } from './history-index-helpers.mjs';

// Task 25 on the fixture: curriculum generations and study programs are
// rows. A generated workbook import seeds them; the public files stay the
// committed parity files until a new generation and its programs are
// published, whose sorts readiness keeps unique; the database guards
// refuse every row that names the wrong generation and a new code of a
// published row.

const nothingToResume = () => Promise.resolve();
const coursesFile = 'courses.json';
const invalidKey = 'INVALID_FOREIGN_KEY';
const stillReferenced =
  /violates foreign key constraint \\"curriculum_entries_generation_foreign\\"/u;

const filled = (value) => value !== null && value !== undefined && value !== '';

const importsWorkbook = async ({ context, t, target }) => {
  const stdout = [];
  const stderr = [];
  const exitCode = await runImportCli(
    [],
    {
      DIRECTUS_TOKEN: target.token,
      DIRECTUS_URL: target.base.href,
      WORKBOOK_PATH: context.workbook,
    },
    {
      createRequest: (config) => createDirectusRequest(config),
      stderr: (line) => {
        stderr.push(line);
      },
      stdout: (line) => {
        stdout.push(line);
      },
    },
  );
  assert.equal(exitCode, exitCodes.ok, stderr.join('\n'));
  assert.deepEqual(JSON.parse(stdout[0] ?? '{}').blockers, {});
  assert.deepEqual(
    await get(
      target,
      '/items/curriculum_generations?fields=code,label,has_curriculum,published,sort&sort=sort',
    ),
    [
      {
        code: '2013',
        has_curriculum: false,
        label: 'Curriculum 2013',
        published: false,
        sort: 1,
      },
      {
        code: '2018',
        has_curriculum: true,
        label: 'Curriculum 2018',
        published: true,
        sort: 2,
      },
      {
        code: '2023',
        has_curriculum: true,
        label: 'Curriculum 2023',
        published: true,
        sort: 3,
      },
    ],
  );
  const programs = await get(
    target,
    '/items/study_programs?fields=generation.code,code,name,published,sort&sort=-generation,sort&limit=-1',
  );
  assert.deepEqual(
    programs.map((row) => [
      row.generation.code,
      row.sort,
      row.code,
      row.name,
      row.published,
    ]),
    syntheticPrograms.map(({ code, generation, name, sort }) => [
      generation,
      sort,
      code,
      name,
      true,
    ]),
  );
  const { dataset } = context;
  const cells = [
    ...dataset.curriculum_2023,
    ...dataset.curriculum_2018,
  ].flatMap((row) =>
    Object.entries(row).filter(
      ([key, value]) => key.startsWith('state_') && filled(value),
    ),
  );
  const states = await get(
    target,
    '/items/curriculum_entry_program_states?fields=entry.generation,program.generation&limit=-1',
  );
  assert.equal(states.length, cells.length, 'one state row per filled cell');
  assert.ok(
    states.every((row) => row.entry.generation === row.program.generation),
  );
  const labels = dataset.course_equivalencies.flatMap((row) =>
    [row.course_2023, row.course_2018, row.course_2013].filter(filled),
  );
  const members = await get(
    target,
    '/items/course_equivalency_members?fields=label&limit=-1',
  );
  assert.equal(members.length, labels.length, 'one member per filled label');
  const settled = await settle(target, { limitMs: 180_000 });
  t.diagnostic(`imported workbook settled after ${settled.elapsedMs} ms`);
};

// The four prepared files hold the committed parity data, the workbook's
// dataset.
const matchesCommitted = async ({ context, target }) => {
  const answer = await readiness(target);
  assert.equal(answer.ready, true, JSON.stringify(answer));
  const digests = await preparedDigests(target);
  const live = await liveFiles(target);
  assert.deepEqual(live.digests, digests);
  const expected = await expectedData('parity');
  for (const filename of publicFiles) {
    const file = filename.replace('.json', '');
    assert.deepEqual(
      asData(file, live.parsed[filename]),
      expected[file],
      filename,
    );
  }
  const keys = Object.keys(live.parsed[coursesFile][0] ?? {});
  assert.equal(
    keys.some((key) => key.includes('-state-')),
    true,
  );
  context.baseline = live;
};

const unchanged = async (target, baseline) => {
  assert.deepEqual(await preparedDigests(target), baseline.digests);
};

// Directus 12.3.1 cuts the states under a course link's entry to the
// nested limit of the read; the export's native query reads them whole.
const readsStatesWhole = async (target, link) => {
  const statesUnder = async (deep) => {
    const [row] = await get(
      target,
      `/items/course_curricula?fields=entry.program_states.state&filter[id][_eq]=${link}&deep=${encodeURIComponent(JSON.stringify(deep))}`,
    );
    return row.entry.program_states.length;
  };
  assert.equal(
    await statesUnder({ entry: { program_states: { _limit: 1 } } }),
    1,
  );
  assert.equal(
    await statesUnder(readQuery(coursesDefinition.related.curricula).deep),
    2,
  );
};

// A published generation or program without a sort, or sharing one with
// a sibling, blocks courses.json until the sort is corrected.
const blocksMovedKeys = async (target, { ab, generation }) => {
  const generationPath = `/items/curriculum_generations/${generation}`;
  const programPath = `/items/study_programs/${ab}`;
  const changes = [
    [generationPath, { sort: null }, 4, 'curriculum_generation_unsorted'],
    [generationPath, { sort: 3 }, 4, 'curriculum_generation_sort_shared'],
    [programPath, { sort: null }, 2, 'study_program_unsorted'],
    [programPath, { sort: 1 }, 2, 'study_program_sort_shared'],
  ];
  for (const [pathname, values, sort, code] of changes) {
    await patch(target, pathname, values);
    const blocked = await readiness(target);
    assert.deepEqual(
      [blocked.blockers, blocked.blockedFiles, blocked.issueCounts[code]],
      [[code], [coursesFile], 1],
      code,
    );
    assert.equal(
      blocked.links[code],
      `/admin/content/${pathname.split('/', 3)[2]}`,
    );
    await patch(target, pathname, { sort });
  }
  const restored = await readiness(target);
  assert.equal(restored.ready, true, JSON.stringify(restored.blockers));
};

// Unpublished rows add nothing; published ones add exactly their keys.
const publishesOnlyWhenPublished = async ({ context, target }) => {
  const [course] = await get(
    target,
    '/items/courses?fields=id&sort=id&limit=1',
  );
  context.added = await addGeneration(target, course.id);
  const { ab, cd, generation } = context.added;
  await readsStatesWhole(target, context.added.link);
  await unchanged(target, context.baseline);
  await patch(target, `/items/study_programs/${ab}`, { published: true });
  await patch(target, `/items/study_programs/${cd}`, { published: true });
  await unchanged(target, context.baseline);
  await patch(target, `/items/curriculum_generations/${generation}`, {
    published: true,
  });
  const published = await liveFiles(target);
  assert.deepEqual(await preparedDigests(target), published.digests);
  const others = publicFiles.filter((name) => name !== coursesFile);
  for (const filename of others) {
    assert.equal(
      published.digests[filename],
      context.baseline.digests[filename],
    );
  }
  const [first, ...rest] = published.parsed[coursesFile];
  assert.deepEqual(
    [withoutNewGeneration(first), ...rest],
    context.baseline.parsed[coursesFile],
  );
  const added = Object.keys(first).filter((key) =>
    key.startsWith(`${newGeneration}-`),
  );
  assert.deepEqual(added, [
    `${newGeneration}-available`,
    `${newGeneration}-name`,
    `${newGeneration}-code`,
    `${newGeneration}-level`,
    `${newGeneration}-semester`,
    `${newGeneration}-channel`,
    `${newGeneration}-state-cd`,
    `${newGeneration}-state-ab`,
    `${newGeneration}-credits`,
  ]);
  const keys = Object.keys(first);
  assert.ok(
    keys.indexOf(`${newGeneration}-available`) < keys.indexOf('2023-available'),
  );
  assert.equal(first[`${newGeneration}-state-cd`], 'B');
  await blocksMovedKeys(target, context.added);
  // Unpublishing one program removes exactly its state key.
  await patch(target, `/items/study_programs/${ab}`, { published: false });
  const narrowed = await liveFiles(target);
  const [again] = narrowed.parsed[coursesFile];
  assert.deepEqual(
    Object.keys(again),
    keys.filter((key) => key !== `${newGeneration}-state-ab`),
  );
  await patch(target, `/items/curriculum_generations/${generation}`, {
    published: false,
  });
  await unchanged(target, context.baseline);
};

const post = (pathname, body) => ({ body, method: 'POST', path: pathname });
const patchOf = (pathname, body) => ({
  body,
  method: 'PATCH',
  path: pathname,
});

// Every guard and domain key over REST, each write with the code Directus
// answers.
const refusesWrongRows = async ({ context, target }) => {
  const { cd, entry, generation } = context.added;
  const current = await generationId(target, '2023');
  const labelOnly = await generationId(target, '2013');
  const [currentProgram] = await get(
    target,
    `/items/study_programs?fields=id&filter[generation][_eq]=${current}&limit=1`,
  );
  const [member] = await get(
    target,
    `/items/course_equivalency_members?fields=id,equivalency&filter[generation][_eq]=${current}&limit=1`,
  );
  const [year] = await get(
    target,
    '/items/academic_years?fields=id&filter[published][_eq]=true&limit=1',
  );
  const attempts = [
    [
      'duplicate generation code',
      post('/items/curriculum_generations', {
        code: newGeneration,
        label: 'Twice',
      }),
      'RECORD_NOT_UNIQUE',
    ],
    [
      'duplicate program per generation',
      post('/items/study_programs', { code: 'cd', generation, name: 'Twice' }),
      'RECORD_NOT_UNIQUE',
    ],
    [
      'duplicate state per entry and program',
      post('/items/curriculum_entry_program_states', {
        entry,
        program: cd,
        state: 'X',
      }),
      'RECORD_NOT_UNIQUE',
    ],
    [
      'duplicate member per generation',
      post('/items/course_equivalency_members', {
        equivalency: member.equivalency,
        generation: current,
        label: 'Twice',
      }),
      'RECORD_NOT_UNIQUE',
    ],
    [
      "state row of another generation's program",
      post('/items/curriculum_entry_program_states', {
        entry,
        program: currentProgram.id,
        state: 'X',
      }),
      invalidKey,
    ],
    [
      'entry for a label-only generation',
      post('/items/curriculum_entries', {
        generation: labelOnly,
        name: 'Synthetic 2013 Entry',
      }),
      invalidKey,
    ],
    [
      'entry generation change while dependants carry it',
      patchOf(`/items/curriculum_entries/${entry}`, { generation: current }),
      invalidKey,
    ],
    [
      'member entry of another generation',
      patchOf(`/items/course_equivalency_members/${member.id}`, { entry }),
      invalidKey,
    ],
    [
      "program's generation change while states name it",
      patchOf(`/items/study_programs/${cd}`, { generation: current }),
      invalidKey,
    ],
    [
      'has_curriculum cleared while entries exist',
      patchOf(`/items/curriculum_generations/${generation}`, {
        has_curriculum: false,
      }),
      invalidKey,
    ],
    [
      'code change of a published program',
      patchOf(`/items/study_programs/${cd}`, { code: 'ce' }),
      invalidKey,
    ],
    [
      'code change of a published generation',
      patchOf(`/items/curriculum_generations/${current}`, { code: '2024' }),
      invalidKey,
    ],
    [
      'label change of a published academic year',
      patchOf(`/items/academic_years/${year.id}`, { label: '2099/2100' }),
      invalidKey,
    ],
  ];
  const answered = [];
  for (const [label, write] of attempts) {
    answered.push([label, await refusedWrite(target, write)]);
  }
  assert.deepEqual(
    answered,
    attempts.map(([label, , code]) => [label, code]),
  );
  // The unpublished new generation takes a new code, and back.
  const renamed = `/items/curriculum_generations/${generation}`;
  await patch(target, renamed, { code: `${newGeneration}x` });
  await patch(target, renamed, { code: newGeneration });
  // A referenced generation cannot be deleted (NO ACTION); Directus
  // 12.3.1 answers a delete's database error untranslated, as a 500.
  const deleted = await request(
    target,
    `/items/curriculum_generations/${generation}`,
    { method: 'DELETE', token: target.token },
  );
  assert.equal(deleted.status, 500);
  assert.match(await deleted.text(), stillReferenced);
  assert.equal(
    (await generationId(target, newGeneration)) === generation,
    true,
  );
  await removeGeneration(target, context.added);
  await unchanged(target, context.baseline);
};

test('manages curriculum generations and study programs as rows on the fixture', async (t) => {
  const target = targetFrom(process.env);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'generations-programs-'),
  );
  const dataset = parityDataset();
  const context = {
    added: null,
    baseline: null,
    dataset,
    workbook: path.join(directory, 'synthetic.xlsx'),
  };
  let resume = nothingToResume;
  try {
    await syntheticWorkbook(dataset).xlsx.writeFile(context.workbook);
    const scenario = { context, t, target };
    await withDataModel(
      target,
      async () => {
        try {
          await t.test(
            'a generated workbook import seeds three generations, the programs of its sheets, one state row per filled cell and one member per label',
            () => importsWorkbook(scenario),
          );
          await t.test(
            'the four prepared files hold the committed parity data',
            () => matchesCommitted(scenario),
          );
          await t.test(
            'a new generation and its programs publish nothing until both are published, then exactly their keys, in an order readiness keeps',
            () => publishesOnlyWhenPublished(scenario),
          );
          await t.test(
            'wrong generations, duplicates and new key texts of published rows are refused over REST',
            () => refusesWrongRows(scenario),
          );
        } finally {
          resume = await pauseAutomaticProcessing(target);
        }
      },
      { automatic: true },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  await resume();
  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
