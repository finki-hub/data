import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { searchBookmark } from '../src/checkpoint-presets.js';
import { installPresentation } from '../src/data-model/presentation.js';
import { curriculumBookmark } from '../src/data-model/presentation/presets.js';
import { runSetup } from '../src/setup.js';
import { assertMarkerPresent, targetFrom } from './isolated-target.mjs';
import {
  adminRequest,
  assertNoAccessResidue,
  createItem,
  errorCode,
  userCollections,
  withDataModel,
} from './relational/data-model-helpers.mjs';
import {
  get,
  patch,
  rebuild,
  remove,
} from './relational/history-index-helpers.mjs';
import {
  installHistoryRunner,
  removeHistoryRunner,
} from './relational/history-runner.mjs';
import { callAs, withAccessUsers } from './relational/operations-helpers.mjs';
import {
  entryFields,
  fileIds,
  firstSnapshot,
  importSnapshot,
  names,
  optionsAs,
  removeFiles,
  searchAs,
  searchFields,
  secondSnapshot,
  tieName,
  tieRows,
  visibleUsers,
  withRestrictedSearcher,
} from './search-relational-helpers.mjs';

// Course-history Search on the installed relational model: the Moodle
// users come through the supported snapshot import, the history index
// and mappings exist beside them, and Search still matches the raw
// Courses text exactly, reads its options from the caller's own rows,
// and passes Studio's relational native filters to Directus as the
// caller. The Needs review bookmarks setup installs are the registry's,
// and the dashboard's readiness links resolve to them.

const bookmarkLink = /^\/content\/(?<page>[a-z_]+)\?bookmark=(?<id>\d+)$/u;
const courseName = 'Synthetic Search Course';
const yearLabel = '2094/2095';
const exactLf = 'Exact LF';
const profileEntry = 'Profile Entry';
const sharedEntry = 'Shared Entry';
const hiddenEntry = 'Hidden Entry';
const mappedEntry = 'Mapped Entry';
const usersPath = '/items/moodle_users?fields=id&limit=-1';

// The ids of the current Moodle users.
const userIds = async (target) => {
  const users = await get(target, usersPath);
  return new Set(users.map(({ id }) => id));
};

const labelFilter = (label) => ({
  history_memberships: { entry: { label: { _eq: label } } },
});

// A test-only readiness check with one review view.
const extraCheck = {
  code: 'synthetic_search_extra',
  description: 'A synthetic check of the Search suite.',
  gates: [],
  generationScoped: false,
  page: 'moodle_course_entries',
  review: {
    bookmark: 'Synthetic extra review',
    fields: ['label'],
    filter: { label: { _starts_with: 'Synthetic' } },
    lists: 'counted',
    sort: ['label'],
  },
  severity: 'warning',
  source: {
    aggregate: 'count',
    field: 'id',
    filter: { label: { _starts_with: 'Synthetic' } },
    kind: 'count',
  },
};

const globalBookmarks = (target) =>
  get(
    target,
    '/presets?fields=id,bookmark,collection,filter,layout,layout_query&filter[bookmark][_nnull]=true&filter[user][_null]=true&filter[role][_null]=true&limit=-1',
  );

// Setup installs one global bookmark per registry entry with a review, on
// its page with its filter, columns and order; the readiness read links
// each such check to that bookmark and every other check to its page; a
// test-only extra check gets exactly one more bookmark on a rerun.
const installsReviewViews = async ({ directus, t, target }) => {
  await runSetup(directus);
  const installed = await globalBookmarks(target);
  const reviewed = readinessRegistry.filter(({ review }) => review);
  for (const { page, review } of reviewed) {
    const matching = installed.filter(
      ({ bookmark, collection }) =>
        bookmark === review.bookmark && collection === page,
    );
    assert.equal(matching.length, 1, review.bookmark);
    assert.deepEqual(matching[0].filter, review.filter);
    assert.deepEqual(matching[0].layout_query.tabular.fields, review.fields);
    assert.deepEqual(matching[0].layout_query.tabular.sort, review.sort);
  }
  const search = installed.filter(({ bookmark }) => bookmark === 'Search');
  assert.deepEqual(
    search.map(({ collection, layout }) => [collection, layout]),
    [['moodle_users', 'finki-hub-course-search']],
  );
  // No other shared bookmark: a hand-written review view would show here.
  assert.deepEqual(
    installed.map(({ bookmark }) => bookmark).toSorted(),
    [
      searchBookmark.bookmark,
      curriculumBookmark.bookmark,
      ...reviewed.map(({ review }) => review.bookmark),
    ].toSorted(),
  );
  const { checks } = await get(target, '/finki-hub-data-status/readiness');
  for (const { code, page, review } of readinessRegistry) {
    const check = checks.find((candidate) => candidate.code === code);
    if (review === undefined) {
      assert.equal(check?.link, `/content/${page}`, code);
      assert.equal(check?.lists, null, code);
      continue;
    }
    const { groups } = bookmarkLink.exec(check?.link ?? '') ?? {};
    const preset = installed.find(({ id }) => String(id) === groups?.id);
    assert.equal(groups?.page, page, code);
    assert.equal(preset?.bookmark, review.bookmark, code);
    // The dashboard says when the view lists candidates, not the count.
    assert.equal(check?.lists, review.lists, code);
  }
  const extra = await installPresentation(directus, [
    ...readinessRegistry,
    extraCheck,
  ]);
  assert.deepEqual(extra.presets.created, 1);
  const after = await globalBookmarks(target);
  const added = after.filter(({ id }) =>
    installed.every((old) => old.id !== id),
  );
  assert.deepEqual(
    added.map(({ bookmark, collection }) => [bookmark, collection]),
    [['Synthetic extra review', 'moodle_course_entries']],
  );
  await remove(target, `/presets/${added[0].id}`);
  const rerun = await installPresentation(directus);
  assert.equal(rerun.presets.created, 0);
  t.diagnostic(
    `review bookmarks: ${reviewed.length} of ${readinessRegistry.length} checks; one more for a test-only check`,
  );
};

// The first snapshot through the import Flow, indexed by the synthetic
// runner; one line mapped to a course and year, one ignored, one mapped
// but still awaiting review; beside them, rows that make the council and
// assignment checks count (a professor row a course override replaces
// counts nowhere).
const importsAndMaps = async ({ state, target }) => {
  await importSnapshot(target, state, {
    rows: firstSnapshot,
    title: 'synthetic-search-a',
  });
  const firstIds = await userIds(target);
  Object.assign(state, { firstIds, runner: true });
  await installHistoryRunner(target);
  const indexed = await rebuild(target);
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  const rows = await get(
    target,
    '/items/moodle_course_entries?fields=id,label&limit=-1',
  );
  const entries = new Map(rows.map(({ id, label }) => [label, id]));
  const course = await createItem(target, 'courses', { name: courseName });
  const year = await createItem(target, 'academic_years', {
    label: yearLabel,
    sort: 94,
  });
  await createItem(target, 'moodle_course_mappings', {
    academic_year: year.data.id,
    course: course.data.id,
    entry: entries.get(mappedEntry),
  });
  await patch(
    target,
    `/items/moodle_course_entries/${entries.get(mappedEntry)}`,
    {
      review_state: 'mapped',
    },
  );
  await patch(
    target,
    `/items/moodle_course_entries/${entries.get('Ignored Entry')}`,
    {
      review_reason: 'Synthetic administrative line',
      review_state: 'ignored',
    },
  );
  const awaiting = await createItem(target, 'courses', {
    name: 'Synthetic Awaiting Course',
  });
  await createItem(target, 'moodle_course_mappings', {
    academic_year: year.data.id,
    course: awaiting.data.id,
    entry: entries.get('Tie Entry'),
  });
  const overridden = await createItem(target, 'courses', {
    name: 'Synthetic Overridden Course',
    professors_override: 'Synthetic Override',
  });
  const assignment = (values) => ({
    course_name: courseName,
    staff: null,
    ...values,
  });
  for (const row of [
    assignment({
      course: course.data.id,
      display_override: 'Synthetic Label',
      role: 'assistant',
      sort: 1,
    }),
    assignment({
      course: course.data.id,
      display_override: '',
      role: 'professor',
      sort: 2,
    }),
    assignment({
      course: overridden.data.id,
      display_override: null,
      role: 'professor',
      sort: 1,
    }),
  ]) {
    await createItem(target, 'teaching_assignments', row);
  }
  await createItem(target, 'student_council', {
    index_number: 'SYN-SEARCH-1',
    position: 'Member',
    year: 2_094,
  });
};

// The query Studio sends for a review view: its columns, order and filter.
const viewPath = (page, review) =>
  `/items/${page}?fields=${review.fields.map((path) => encodeURIComponent(path)).join(',')}&sort=${review.sort.join(',')}&limit=50&filter=${encodeURIComponent(JSON.stringify(review.filter))}`;

// Each review view is a valid REST query of its page, for an
// administrator and for a holder of the Data editor policy (Studio sends
// its filter, columns and order through the item API as the viewer,
// whose query validation refuses what the services accept, such as an
// empty string), and a view that lists the counted records counts,
// through the same API, exactly what readiness counts.
const listsWhatReadinessCounts = async ({ t, target }) => {
  const { checks } = await get(target, '/finki-hub-data-status/readiness');
  const counts = new Map(checks.map(({ code, count }) => [code, count]));
  const compared = [];
  await withAccessUsers(target, async ({ editor }) => {
    for (const { code, page, review } of readinessRegistry) {
      if (review === undefined) continue;
      const answer = await callAs(target, editor, {
        path: viewPath(page, review),
      });
      assert.equal(
        answer.status,
        200,
        `${code}: ${JSON.stringify(answer.body)}`,
      );
    }
  });
  for (const { code, page, review, source } of readinessRegistry) {
    if (review === undefined) continue;
    const filter = encodeURIComponent(JSON.stringify(review.filter));
    const rows = await get(target, viewPath(page, review));
    assert.ok(Array.isArray(rows), code);
    if (review.lists !== 'counted') continue;
    const [aggregate, field] =
      source.kind === 'count' && source.aggregate === 'countDistinct'
        ? ['countDistinct', source.field]
        : ['count', 'id'];
    const [answer] = await get(
      target,
      `/items/${page}?aggregate[${aggregate}]=${field}&filter=${filter}`,
    );
    const listed = Number(answer[aggregate][field]);
    assert.equal(listed, counts.get(code), code);
    if (listed > 0) compared.push(`${code} ${String(listed)}`);
  }
  assert.ok(
    compared.length >= 5,
    'the seeded checks count through their views',
  );
  t.diagnostic(`views listing what readiness counts: ${compared.join(', ')}`);
};

// Exact raw entries, null histories, the LIKE wildcard, 50 users a page,
// ties ordered by id across pages and both profile links.
const matchesRawEntries = async ({ target }) => {
  const token = target.token;
  const boundary = await searchAs(target, token, {
    exclude: ['Exclude LF'],
    include: [exactLf],
  });
  assert.deepEqual(names(boundary), [
    'Boundary CRLF',
    'Boundary Embedded',
    'Boundary Ends',
    'Boundary Starts',
  ]);
  const crlf = await searchAs(target, token, { include: ['Exact CRLF'] });
  assert.deepEqual(names(crlf), ['Boundary CRLF']);
  const wildcard = await searchAs(target, token, { include: ['Under_score'] });
  assert.deepEqual(names(wildcard), ['Boundary Underscore']);
  const withoutAnother = await searchAs(target, token, {
    exclude: ['Another', 'Tie Entry'],
    include: [],
  });
  assert.ok(names(withoutAnother).includes('Boundary Null'));
  assert.ok(!names(withoutAnother).includes('Boundary Starts'));
  const pages = [1, 2].map((page) =>
    searchAs(target, token, {
      include: ['Tie Entry'],
      page,
      sort: '-Courses Count',
    }),
  );
  const [first, second] = await Promise.all(pages);
  assert.equal(first.body.total, tieRows);
  assert.equal(first.body.data.length, 50);
  assert.equal(second.body.data.length, tieRows - 50);
  const ids = [...first.body.data, ...second.body.data].map(({ id }) => id);
  assert.deepEqual(
    ids,
    ids.toSorted((left, right) => left - right),
  );
  assert.equal(new Set(ids).size, tieRows);
  assert.ok(names(first).every((name) => name === tieName));
  const profiles = await searchAs(target, token, {
    include: [profileEntry],
  });
  assert.deepEqual(
    profiles.body.data.map(({ Name, Profile_new, Profile_old }) => [
      Name,
      Profile_new,
      Profile_old,
    ]),
    [
      [
        'Profile Both',
        'https://profiles.example/new/both-a',
        'https://profiles.example/old/both-a',
      ],
      ['Profile Old Only', null, 'https://profiles.example/old/only-a'],
    ],
  );
  const most = await searchAs(target, token, { sort: '-Courses Count' });
  const fewest = await searchAs(target, token, { sort: 'Courses Count' });
  assert.equal(most.body.data[0].Name, 'Mapped Holder');
  assert.equal(fewest.body.data[0].Name, 'Boundary Null');
};

// Mapped, ignored and never-indexed lines are raw labels like any other:
// options list them and Search matches them.
const keepsRawLabels = async ({ target }) => {
  const token = target.token;
  const options = await optionsAs(target, token);
  for (const label of [mappedEntry, 'Ignored Entry', exactLf]) {
    assert.ok(options.body.data.includes(label), label);
  }
  await createItem(target, 'moodle_users', {
    Courses: 'Unindexed Entry',
    'Courses Count': 1,
    Name: 'Unindexed Holder',
  });
  const unindexed = await get(
    target,
    '/items/moodle_course_entries?fields=id&filter[label][_eq]=Unindexed%20Entry',
  );
  assert.deepEqual(unindexed, []);
  const found = await searchAs(target, token, { include: ['Unindexed Entry'] });
  assert.deepEqual(names(found), ['Unindexed Holder']);
  const withUnindexed = await optionsAs(target, token);
  assert.ok(withUnindexed.body.data.includes('Unindexed Entry'));
  for (const label of [mappedEntry, 'Ignored Entry']) {
    const matched = await searchAs(target, token, { include: [label] });
    assert.equal(matched.body.total, 1, label);
  }
};

// Studio's relational filters reach Directus as the caller: through the
// index to the label and to the mapped course, one row per user however
// many of their lines match, and together with raw-entry criteria.
const filtersThroughRelations = async ({ target }) => {
  const token = target.token;
  const byLabel = await searchAs(target, token, {
    filter: { _and: [labelFilter(exactLf)] },
  });
  const raw = await searchAs(target, token, { include: [exactLf] });
  assert.deepEqual(names(byLabel), names(raw));
  const either = await searchAs(target, token, {
    filter: {
      history_memberships: { entry: { label: { _starts_with: 'Exact' } } },
    },
  });
  assert.equal(either.body.total, new Set(names(either)).size);
  assert.equal(
    names(either).filter((name) => name === 'Boundary CRLF').length,
    1,
  );
  const mapped = await searchAs(target, token, {
    filter: {
      history_memberships: {
        entry: { mappings: { course: { name: { _eq: courseName } } } },
      },
    },
  });
  assert.deepEqual(names(mapped), ['Mapped Holder']);
  const combined = await searchAs(target, token, {
    exclude: ['Exclude LF'],
    filter: labelFilter('Another'),
    include: [exactLf],
  });
  assert.deepEqual(names(combined), [
    'Boundary Embedded',
    'Boundary Ends',
    'Boundary Starts',
  ]);
  const quantified = await searchAs(target, token, {
    filter: {
      history_memberships: { _some: { entry: { id: { _nnull: true } } } },
    },
  });
  assert.equal(quantified.status, 400);
};

// Another user's line, name and address, as filter paths that leave the
// caller's own users: back from an entry to every membership of it, back
// from a membership to its user, or counting an entry's memberships.
const crossUserPaths = [
  {
    history_memberships: {
      entry: {
        memberships: {
          moodle_user: { Courses: { _contains: hiddenEntry } },
        },
      },
    },
  },
  {
    history_memberships: {
      entry: {
        memberships: {
          moodle_user: { Mail: { _eq: 'hidden@search.example' } },
        },
      },
    },
  },
  { history_memberships: { moodle_user: { Name: { _starts_with: 'Hid' } } } },
  { history_memberships: { entry: { 'count(memberships)': { _gt: 1 } } } },
];

// Directus joins the rows of a filter path without the caller's row
// permissions on them, and an implicit $FOLLOW relation skips the field
// check of its segment. The restricted searcher's policy (own memberships
// without their user field, no `memberships` alias) keeps REST filters on
// their own users. Search refuses an implicit $FOLLOW relation and every
// path that passes a collection twice on its own: with the memberships'
// user field and the alias granted too, where REST would answer.
const refusesOtherUsers = async (target, { grant, token }) => {
  const hiddenHolder = { Name: { _eq: 'Hidden Searcher' } };
  const followed = {
    history_memberships: {
      entry: {
        '$FOLLOW(moodle_history_memberships, entry)': {
          moodle_user: { Courses: { _contains: hiddenEntry } },
        },
      },
    },
  };
  for (const path of [
    `/items/moodle_history_memberships?fields=entry.label&filter=${encodeURIComponent(JSON.stringify({ moodle_user: hiddenHolder }))}`,
    `/items/moodle_users?fields=Name&filter=${encodeURIComponent(JSON.stringify(followed))}`,
    `/items/moodle_course_entries?fields=label&filter=${encodeURIComponent(JSON.stringify({ '$FOLLOW(moodle_history_memberships, entry)': { moodle_user: hiddenHolder } }))}`,
  ]) {
    const probe = await callAs(target, token, { path });
    assert.equal(probe.status, 403, path);
    assert.equal(probe.body.data, undefined);
  }
  const own = await callAs(target, token, {
    path: '/items/moodle_history_memberships?fields=entry.label&limit=-1',
  });
  assert.deepEqual(own.body.data.map(({ entry }) => entry.label).toSorted(), [
    sharedEntry,
    'Visible Entry',
  ]);
  await grant('moodle_history_memberships', ['id', 'entry', 'moodle_user'], {
    moodle_user: visibleUsers,
  });
  await grant('moodle_course_entries', [...entryFields, 'memberships']);
  for (const filter of [followed, ...crossUserPaths]) {
    const answer = await searchAs(target, token, { filter });
    assert.equal(answer.status, 400, JSON.stringify(filter));
    assert.equal(answer.body.data, undefined);
  }
  await grant('moodle_course_entries', entryFields);
  await grant('moodle_history_memberships', ['id', 'entry'], {
    moodle_user: visibleUsers,
  });
  const administrator = await searchAs(target, target.token, {
    filter: crossUserPaths[0],
  });
  assert.equal(administrator.status, 400);
};

// A caller who reads only some users gets options from those users alone,
// although the entry table and the index they may read hold every label;
// denied fields stay denied through both endpoints and through a path.
const scopesToTheCaller = async ({ target }) => {
  await withRestrictedSearcher(target, async ({ grant, token }) => {
    const readable = await get(
      target,
      '/items/moodle_course_entries?fields=label&filter[label][_eq]=Hidden%20Entry',
    );
    assert.equal(readable.length, 1);
    const listed = await fetch(
      new URL(
        '/items/moodle_course_entries?fields=label&limit=-1',
        target.base,
      ),
      { headers: { authorization: `Bearer ${token}` } },
    );
    const readableEntries = await listed.json();
    const labels = readableEntries.data.map(({ label }) => label);
    assert.ok(labels.includes(hiddenEntry), 'the entry table is readable');
    const options = await optionsAs(target, token);
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.data.toSorted(), [
      sharedEntry,
      'Visible Entry',
    ]);
    const hidden = await searchAs(target, token, { include: [hiddenEntry] });
    assert.equal(hidden.body.total, 0);
    const shared = await searchAs(target, token, { include: [sharedEntry] });
    assert.deepEqual(names(shared), ['Visible Searcher']);
    const throughIndex = await searchAs(target, token, {
      filter: labelFilter(hiddenEntry),
    });
    assert.equal(throughIndex.status, 200);
    assert.equal(throughIndex.body.total, 0);
    const sharedIndex = await searchAs(target, token, {
      filter: labelFilter(sharedEntry),
    });
    assert.deepEqual(names(sharedIndex), ['Visible Searcher']);
    await refusesOtherUsers(target, { grant, token });
    await grant('moodle_history_memberships', null);
    const withoutIndex = await searchAs(target, token, {
      filter: labelFilter(sharedEntry),
    });
    assert.equal(withoutIndex.status, 403);
    assert.equal(errorCode(withoutIndex.body), 'FORBIDDEN');
    assert.equal(withoutIndex.body.data, undefined);
    const plain = await searchAs(target, token, {});
    assert.equal(plain.status, 200);
    await grant(
      'moodle_users',
      searchFields.filter((field) => field !== 'Mail'),
      visibleUsers,
    );
    const noMail = await searchAs(target, token, { include: [sharedEntry] });
    assert.equal(noMail.status, 403);
    assert.equal(noMail.body.data, undefined);
    await grant('moodle_users', ['id', 'Name'], visibleUsers);
    const noCourses = await optionsAs(target, token);
    assert.equal(noCourses.status, 403);
    assert.equal(noCourses.body.data, undefined);
  });
  await assertNoAccessResidue(target);
};

// A replacement snapshot: new ids only, the new profile links and counts,
// raw options of the new rows, and the mapped line kept as an entry with
// its mapping although no user carries it any more.
const survivesReplacement = async ({ state, target }) => {
  const token = target.token;
  const mappings = await get(
    target,
    '/items/moodle_course_mappings?fields=id&limit=-1',
  );
  await importSnapshot(target, state, {
    rows: secondSnapshot,
    title: 'synthetic-search-b',
  });
  const current = await userIds(target);
  const everyone = await searchAs(target, token, { sort: 'Courses Count' });
  const pages = Math.ceil(everyone.body.total / 50);
  const ids = [];
  for (let page = 1; page <= pages; page += 1) {
    const answer = await searchAs(target, token, {
      page,
      sort: 'Courses Count',
    });
    ids.push(...answer.body.data.map(({ id }) => id));
  }
  assert.equal(ids.length, secondSnapshot.length);
  assert.ok(
    ids.every((id) => current.has(id)),
    'every id is a current user',
  );
  assert.ok(
    ids.every((id) => !state.firstIds.has(id)),
    'no id of the old snapshot',
  );
  const profiles = await searchAs(target, token, {
    include: [profileEntry],
  });
  assert.deepEqual(
    profiles.body.data.map(({ Name, Profile_new, Profile_old }) => [
      Name,
      Profile_new,
      Profile_old,
    ]),
    [
      [
        'Profile Both',
        'https://profiles.example/new/both-b',
        'https://profiles.example/old/both-b',
      ],
      ['Profile New Only', 'https://profiles.example/new/only-b', null],
    ],
  );
  const most = await searchAs(target, token, { sort: '-Courses Count' });
  assert.equal(most.body.data[0].Name, 'Replacement Newcomer');
  const replaced = await optionsAs(target, token);
  const options = replaced.body.data;
  assert.ok(options.includes('Fresh Entry'));
  assert.ok(!options.includes(mappedEntry));
  assert.ok(!options.includes('Unindexed Entry'));
  const fresh = await searchAs(target, token, { include: ['Fresh Entry'] });
  assert.deepEqual(names(fresh), ['Replacement Newcomer']);
  // The index waits for the next run; Search does not.
  const indexed = await searchAs(target, token, {
    filter: labelFilter('Fresh Entry'),
  });
  assert.equal(indexed.body.total, 0);
  const kept = await get(
    target,
    '/items/moodle_course_entries?fields=label,review_state,mappings&filter[label][_eq]=Mapped%20Entry',
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].review_state, 'mapped');
  assert.deepEqual(
    await get(target, '/items/moodle_course_mappings?fields=id&limit=-1'),
    mappings,
  );
};

test('keeps raw-history Search and installs the Needs review views of the registry', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = { files: [] };
  const context = { directus, state, t, target };
  let before = new Set();

  await withDataModel(target, async () => {
    before = await fileIds(target);
    try {
      await t.test(
        'installs one bookmark per reviewed check, linked from readiness, and one more for a new check',
        () => installsReviewViews(context),
      );
      await t.test(
        'imports a snapshot, indexes it, and seeds mappings and review issues',
        () => importsAndMaps(context),
      );
      await t.test(
        'opens every review view through the REST API and lists what readiness counts',
        () => listsWhatReadinessCounts(context),
      );
      await t.test(
        'matches exact raw entries with null histories, 50 a page, stable ties and both profile links',
        () => matchesRawEntries(context),
      );
      await t.test(
        'keeps mapped, ignored and unindexed lines as raw labels',
        () => keepsRawLabels(context),
      );
      await t.test(
        'passes relational native filters as the caller, one row per user',
        () => filtersThroughRelations(context),
      );
      await t.test(
        'scopes options, matches and filter paths to the caller and keeps denied fields denied',
        () => scopesToTheCaller(context),
      );
      await t.test(
        'shows only the new snapshot after a replacement, with its links and counts',
        () => survivesReplacement(context),
      );
    } finally {
      if (state.runner === true) await removeHistoryRunner(target);
      await removeFiles(target, state, before);
    }
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  assert.deepEqual(
    [...(await fileIds(target))].filter((id) => !before.has(id)),
    [],
  );
});
