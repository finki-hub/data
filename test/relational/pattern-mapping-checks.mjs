import assert from 'node:assert/strict';

import { defaultYearPattern } from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  assertEqualToResolver,
  countedLinesPath,
  countRun,
  enrollmentCounts,
  patternMappingsPath,
  seedMappings,
} from './counting-helpers.mjs';
import { errorCode, json, request } from './data-model-helpers.mjs';
import { create, get, patch } from './history-index-helpers.mjs';

// The pattern mapping guards on a real Directus, run by the counting
// scenario (counting.integration.mjs) on its seeds: the CHECK that holds
// exactly one of year_pattern and only_in_year, the pattern guard hook
// with the texts of the plan's section 6, and the delete of a mapping
// removed from its academic year's list, as Studio's list sends it. A
// refused write changes no mapping.

const yearChoiceCheck = 'moodle_pattern_mappings_year_choice_check';
const mappingFields = 'id,course,pattern,year_pattern,only_in_year';
const noGroup =
  'Invalid pattern mapping: year_pattern: no group named start or end';
// The seeded only-in-year mapping (Beta's lab line in y3) and Gamma's
// all-years mapping.
const labPattern = seedMappings.find(
  (mapping) => mapping[2].only_in_year !== undefined,
)[1];
const gammaPattern = seedMappings.find(([course]) => course === 'c')[1];

// The status and body of a write.
const send = async (target, path, [method, body]) => {
  const response = await request(
    target,
    path,
    json(method, body, target.token),
  );
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

const mappingsNow = (target) =>
  get(
    target,
    `${patternMappingsPath}?fields=${mappingFields}&sort=id&limit=-1`,
  );

const mappingOf = async (target, pattern) => {
  const [mapping] = await get(
    target,
    `${patternMappingsPath}?fields=${mappingFields}&filter[pattern][_eq]=${encodeURIComponent(pattern)}&limit=1`,
  );
  assert.ok(mapping !== undefined, pattern);
  return mapping;
};

// Directus 12.3.1 translates no CHECK violation (SQLSTATE 23514): it
// answers HTTP 500 with the database's message, which names the
// constraint (the suite's token is an administrator's).
const assertYearChoiceRefused = ({ body, status }) => {
  assert.equal(status, 500, JSON.stringify(body));
  assert.equal(errorCode(body), 'INTERNAL_SERVER_ERROR');
  assert.ok(
    body.errors[0].message.includes(
      `violates check constraint "${yearChoiceCheck}"`,
    ),
    JSON.stringify(body),
  );
};

const assertGuardRefused = ({ body, status }, field, message) => {
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(errorCode(body), 'INVALID_PAYLOAD');
  assert.equal(body.errors[0].message, message);
  assert.equal(body.errors[0].extensions.field, field);
};

// The guard hook leaves the choice of year to the CHECK, which refuses a
// create or an update that sets both or neither. A create that leaves
// year_pattern out takes its column default, so neither is an explicit
// null.
export const refusesBothOrNeitherYear = async (target, state) => {
  const before = await mappingsNow(target);
  const course = state.ids.get('c');
  const year = state.ids.get('y1');
  for (const payload of [
    {
      course,
      only_in_year: year,
      pattern: 'Counting Both',
      year_pattern: defaultYearPattern,
    },
    {
      course,
      only_in_year: null,
      pattern: 'Counting Neither',
      year_pattern: null,
    },
  ]) {
    assertYearChoiceRefused(
      await send(target, patternMappingsPath, ['POST', payload]),
    );
  }
  const allYears = await mappingOf(target, gammaPattern);
  const onlyInYear = await mappingOf(target, labPattern);
  assert.equal(onlyInYear.year_pattern, null);
  for (const [mapping, edit] of [
    [allYears, { only_in_year: year }],
    [onlyInYear, { only_in_year: null }],
  ]) {
    assertYearChoiceRefused(
      await send(target, `${patternMappingsPath}/${mapping.id}`, [
        'PATCH',
        edit,
      ]),
    );
  }
  assert.deepEqual(await mappingsNow(target), before);
};

// The guard compiles a written pattern and year pattern with the u flag
// and requires a group named start or end in a year pattern. It refuses
// a create, an update and a course form's nested row alike.
export const refusesInvalidPatterns = async (target, state) => {
  const before = await mappingsNow(target);
  const course = state.ids.get('c');
  const created = (fields) =>
    send(target, patternMappingsPath, [
      'POST',
      {
        course,
        pattern: 'Counting Guard',
        year_pattern: defaultYearPattern,
        ...fields,
      },
    ]);
  assertGuardRefused(
    await created({ pattern: '(' }),
    'pattern',
    'Invalid pattern mapping: pattern: Unterminated group',
  );
  // Valid without the u flag, refused with it.
  assertGuardRefused(
    await created({ pattern: String.raw`Counting Guard\-` }),
    'pattern',
    'Invalid pattern mapping: pattern: Invalid escape',
  );
  assertGuardRefused(
    await created({ year_pattern: String.raw`(?<start>\d{4}` }),
    'year_pattern',
    'Invalid pattern mapping: year_pattern: Unterminated group',
  );
  for (const yearPattern of [
    String.raw`(?<year>\d{4})`,
    String.raw`\d{4}/\d{4}`,
  ]) {
    assertGuardRefused(
      await created({ year_pattern: yearPattern }),
      'year_pattern',
      noGroup,
    );
  }
  const { id } = await mappingOf(target, gammaPattern);
  assertGuardRefused(
    await send(target, `${patternMappingsPath}/${id}`, [
      'PATCH',
      { pattern: '[' },
    ]),
    'pattern',
    'Invalid pattern mapping: pattern: Unterminated character class',
  );
  assertGuardRefused(
    await send(target, `${patternMappingsPath}/${id}`, [
      'PATCH',
      { year_pattern: String.raw`(\d{4})` },
    ]),
    'year_pattern',
    noGroup,
  );
  assertGuardRefused(
    await send(target, `/items/courses/${course}`, [
      'PATCH',
      {
        pattern_mappings: {
          create: [{ pattern: '(', year_pattern: defaultYearPattern }],
          delete: [],
          update: [],
        },
      },
    ]),
    'pattern',
    'Invalid pattern mapping: pattern: Unterminated group',
  );
  assert.deepEqual(await mappingsNow(target), before);
};

// Studio removes a row from an academic year's Pattern mappings list with
// a PATCH of the year that lists it under delete. An only-in-year mapping
// cannot lose its year, so the relation deletes it, with the lines it
// counted, and the year's other rows stay. The next run counts that
// course's all-years mappings in the year again.
export const deletesADeselectedMapping = async (target, state) => {
  const relation = await get(
    target,
    '/relations/moodle_pattern_mappings/only_in_year',
  );
  assert.equal(relation.meta.one_deselect_action, 'delete');
  const year = state.ids.get('y3');
  const lab = await mappingOf(target, labPattern);
  assert.equal(lab.only_in_year, year);
  const kept = await create(target, state, [
    'moodle_pattern_mappings',
    {
      course: state.ids.get('a'),
      only_in_year: year,
      pattern: 'Counting Kept',
    },
  ]);
  const listed = async () => {
    const { pattern_mappings } = await get(
      target,
      `/items/academic_years/${year}?fields=pattern_mappings`,
    );
    return pattern_mappings.toSorted((left, right) => left - right);
  };
  const countedByLab = () =>
    get(
      target,
      `${countedLinesPath}?fields=id&filter[pattern_mapping][_eq]=${lab.id}`,
    );
  assert.deepEqual(
    await listed(),
    [lab.id, kept].toSorted((left, right) => left - right),
  );
  const countedBefore = await countedByLab();
  assert.ok(countedBefore.length > 0);
  const before = await enrollmentCounts(target, state);
  assert.equal(before['b/y3'], 1);

  await patch(target, `/items/academic_years/${year}`, {
    pattern_mappings: { create: [], delete: [lab.id], update: [] },
  });
  state.items = state.items.filter(
    ([collection, id]) =>
      collection !== 'moodle_pattern_mappings' || id !== lab.id,
  );
  assert.deepEqual(await listed(), [kept]);
  assert.deepEqual(
    await get(
      target,
      `${patternMappingsPath}?fields=id&filter[id][_eq]=${lab.id}`,
    ),
    [],
  );
  assert.deepEqual(await countedByLab(), []);

  const answer = await countRun(target);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const after = await enrollmentCounts(target, state);
  assert.equal(after['b/y3'], 2);
  await assertEqualToResolver(target);
};
