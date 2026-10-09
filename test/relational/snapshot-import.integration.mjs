import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { snapshotFields } from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { readCsv } from '../../directus/extensions/directus-extension-data-operations/src/snapshot/csv-parser.js';
import { fingerprintOf } from '../../directus/extensions/directus-extension-data-operations/src/snapshot/fingerprint.js';
import {
  applySchemaConstraints,
  applySourceInvalidation,
} from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { flowFamilyCodes } from '../../src/flows/flow-template.js';
import { historyIndexFlows } from '../../src/flows/index-histories.js';
import { installFlowFamily } from '../../src/flows/registry.js';
import {
  installSnapshotFolder,
  snapshotFolder,
} from '../../src/flows/snapshot-folder.js';
import {
  snapshotFlowId,
  snapshotImportFlow,
  snapshotImportFlows,
} from '../../src/flows/snapshot-import.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import {
  adminRequest,
  createItem,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';
import { historyRunnerId, runnerPath } from './history-index-helpers.mjs';
import { installHistoryRunner } from './history-runner.mjs';
import {
  assertRawRows,
  backupTitlePrefix,
  call,
  codeOf,
  count,
  csvHeader,
  csvRecord,
  fieldsQuery,
  get,
  installProbe,
  longLineRows,
  messageOf,
  probeImportFlowId,
  probePromoteFlowId,
  probeStagingFlowId,
  removeIfPresent,
  runImport,
  setRequired,
  snapshotPath,
  statusPath,
  syntheticRows,
  triggerProbe,
  uploadCsv,
  withReader,
  writeSnapshot,
} from './snapshot-import-helpers.mjs';

// The Flows a family install created and skipped.
const flowLists = ({ created, skipped }) => ({ created, skipped });

const allDomains = ['history_index', 'enrollments', 'publication'];
const previousRows = 2_000;
const bigRows = 30_000;
const sampled = [
  0,
  1,
  2,
  3,
  7,
  8,
  9,
  10,
  97,
  253,
  333,
  500,
  4_999,
  15_000,
  ...longLineRows,
  29_999,
];
const lateDuplicatePattern =
  /^Invalid rows: \d+ problems? in \d+ rows: (?:.+; )?row 29991 \(line \d+\) ID_new repeats the id of row 7/u;
const lateQuotePattern = /^Invalid CSV: unterminated quote on line \d+$/u;
const warningPattern =
  /^HISTORY_LINE_TOO_LONG: 2 rows over 2048 bytes: \d+, \d+$/u;
const syntheticTextPattern = /Synthetic|Unterminated/u;
const notNullPattern = /^Unexpected error \(code: 23502\)$/u;
const folderPattern = /^File outside folder "Moodle snapshots \(private\)"$/u;
const probeIds = [probeImportFlowId, probePromoteFlowId, probeStagingFlowId];
// The staged rows the failed replacement leaves behind (see
// rollsBackFailedReplacement); the next import deletes them.
const poisonRows = 3;
const blankLines = 3_000_000;

const sortByKey = (left, right) => left.key.localeCompare(right.key);

const installsFlow = async (target, directus, state) => {
  // Probe Flows an interrupted earlier run left behind would make the
  // deterministic ids below collide.
  for (const id of probeIds) {
    assert.equal(await removeIfPresent(target, `/flows/${id}`), null);
  }
  const folders = await installSnapshotFolder(directus);
  Object.assign(state, { folderCreated: folders.created.length > 0 });
  assert.deepEqual(await installSnapshotFolder(directus), {
    created: [],
    skipped: [snapshotFolder.name],
  });
  const listed = await get(target, '/flows?fields=id&limit=-1');
  const present = new Set(listed.map(({ id }) => id));
  const backups = await get(
    target,
    `/files?fields=id&filter[title][_starts_with]=${backupTitlePrefix}&limit=-1`,
  );
  Object.assign(state, {
    backupsBefore: new Set(backups.map(({ id }) => id)),
    flowsCreated: [...historyIndexFlows, ...snapshotImportFlows]
      .map(({ id }) => id)
      .filter((id) => !present.has(id)),
  });
  await installFlowFamily(directus, flowFamilyCodes.history);
  const first = await installFlowFamily(directus, flowFamilyCodes.snapshot);
  assert.equal(first.created.length + first.skipped.length, 1);
  assert.deepEqual(
    flowLists(await installFlowFamily(directus, flowFamilyCodes.snapshot)),
    {
      created: [],
      skipped: [snapshotImportFlow.name],
    },
  );
  const live = await get(
    target,
    `/flows/${snapshotFlowId}?fields=status,trigger,accountability,operation,options`,
  );
  assert.deepEqual(live, {
    accountability: 'activity',
    operation: snapshotImportFlow.entry,
    options: snapshotImportFlow.options,
    status: 'active',
    trigger: 'manual',
  });
  const operations = await get(
    target,
    `/operations?fields=key,type,resolve,reject&filter[flow][_eq]=${snapshotFlowId}&limit=-1`,
  );
  assert.deepEqual(
    operations.toSorted(sortByKey),
    snapshotImportFlow.operations
      .map(({ key, reject, resolve, type }) => ({ key, reject, resolve, type }))
      .toSorted(sortByKey),
  );
  state.probes.push(historyRunnerId);
  await installHistoryRunner(target);
  // Each probe is recorded before it is created, so the cleanup removes
  // whatever part of the three an interrupted install created.
  state.probes.push(probeImportFlowId);
  await installProbe(target, {
    id: probeImportFlowId,
    operation: 'finki-hub-snapshot-import',
    options: {
      file: '{{ $trigger.body.file }}',
    },
  });
  state.probes.push(probePromoteFlowId);
  await installProbe(target, {
    id: probePromoteFlowId,
    operation: 'finki-hub-snapshot-promote',
    options: {
      allow_empty: '{{ $trigger.body.allow_empty }}',
      confirm_replace: '{{ $trigger.body.confirm_replace }}',
      staging_fingerprint: '{{ $trigger.body.staging_fingerprint }}',
    },
  });
  state.probes.push(probeStagingFlowId);
  await installProbe(target, {
    id: probeStagingFlowId,
    operation: 'item-create',
    options: {
      collection: 'moodle_import_rows',
      emitEvents: false,
      payload: { Name: 'Synthetic Probe Row' },
      permissions: '$full',
    },
  });
};

// A first snapshot, promoted into an empty project, indexed by the
// synthetic history runner and given one manual mapping.
const promotesFirstSnapshot = async (target, state) => {
  const rows = syntheticRows(previousRows, 70_000);
  const file = path.join(state.dir, 'snapshot-a.csv');
  await writeSnapshot(file, rows);
  const id = await uploadCsv(target, {
    file,
    state,
    title: 'synthetic-snapshot-a',
  });
  const run = await runImport(target, { confirm_replace: true, file: id });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.state, 'completed');
  assert.equal(run.body.rows, previousRows);
  assert.equal(run.body.previousRows, 0);
  assert.equal(run.body.backup.rows, 0);
  assert.equal(run.body.fingerprint, fingerprintOf(rows));
  assert.deepEqual(run.body.pending, allDomains);
  Object.assign(state, {
    firstFile: id,
    previous: { fingerprint: run.body.fingerprint, rows },
  });
  const indexed = await call(target, runnerPath, {
    body: JSON.stringify({ collection: 'moodle_users' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body));
  assert.equal(indexed.body.completed, true);
  const memberships = await count(target, 'moodle_history_memberships');
  assert.ok(memberships > previousRows);
  const course = await createItem(target, 'courses', {
    name: 'Synthetic Snapshot Course',
  });
  const year = await createItem(target, 'academic_years', {
    label: '2033/2034',
    sort: 1,
  });
  const [entry] = await get(
    target,
    '/items/moodle_course_entries?fields=id,first_seen&sort=id&limit=1',
  );
  const mapping = await createItem(target, 'moodle_course_mappings', {
    academic_year: year.data.id,
    course: course.data.id,
    entry: entry.id,
  });
  const entries = await count(target, 'moodle_course_entries');
  Object.assign(state, {
    entries,
    entry: entry.id,
    firstSeen: entry.first_seen,
    mapping: mapping.data.id,
    memberships,
  });
};

const refusesDirectAndUnauthorised = async (target, state, t) => {
  const before = await get(target, statusPath);
  for (const [method, url, body] of [
    ['POST', '/items/moodle_import_rows', { Name: 'Synthetic Direct Row' }],
    ['PATCH', '/items/moodle_import_rows/1', { Name: 'Synthetic Direct Row' }],
    ['DELETE', '/items/moodle_import_rows/1', null],
  ]) {
    const outcome = await call(target, url, {
      body: body === null ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method,
    });
    assert.equal(outcome.status, 403, `${method} ${url}`);
    assert.equal(codeOf(outcome.body), 'COORDINATION_WRITE_GUARDED');
  }
  const form = new FormData();
  form.append(
    'file',
    new Blob(['Name\nSynthetic Native Row\n'], { type: 'text/csv' }),
    'native.csv',
  );
  const native = await call(target, '/utils/import/moodle_import_rows', {
    body: form,
    method: 'POST',
  });
  assert.notEqual(native.status, 200);
  assert.notEqual(native.status, 204);
  const probe = await triggerProbe(target, probeStagingFlowId, { body: {} });
  assert.equal(probe.status, 500, JSON.stringify(probe.body));
  t.diagnostic(
    `native import ${native.status} ${codeOf(native.body)}; event-less item-create ${probe.status} ${codeOf(probe.body)}`,
  );
  assert.equal(await count(target, 'moodle_import_rows'), 0);
  const unconfirmed = await runImport(target, {
    confirm_replace: false,
    file: state.firstFile,
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(codeOf(unconfirmed.body), 'CONFIRMATION_REQUIRED');
  await withReader(target, async (token) => {
    const flow = await runImport(
      target,
      { confirm_replace: true, file: state.firstFile },
      token,
    );
    // The import operation's own caller check, relayed by import_failed.
    assert.equal(flow.status, 403, JSON.stringify(flow.body));
    assert.equal(codeOf(flow.body), 'SNAPSHOT_FORBIDDEN');
    assert.equal(messageOf(flow.body), 'Forbidden');
    const imported = await triggerProbe(target, probeImportFlowId, {
      body: { file: state.firstFile },
      token,
    });
    assert.equal(imported.status, 403, JSON.stringify(imported.body));
    assert.equal(codeOf(imported.body), 'SNAPSHOT_FORBIDDEN');
    const promoted = await triggerProbe(target, probePromoteFlowId, {
      body: {
        confirm_replace: true,
        staging_fingerprint: state.previous.fingerprint,
      },
      token,
    });
    assert.equal(promoted.status, 403, JSON.stringify(promoted.body));
    assert.equal(codeOf(promoted.body), 'SNAPSHOT_FORBIDDEN');
  });
  const after = await get(target, statusPath);
  assert.equal(after.revisions.source, before.revisions.source);
  assert.equal(await count(target, 'moodle_users'), previousRows);
  const report = await get(target, snapshotPath);
  assert.equal(report.state, 'completed');
};

// A replacement that fails after both of its DELETEs, on the database: a
// temporary NOT NULL on moodle_users.Timezone_new (every active row has
// one) refuses the last staged row inside the INSERT ... SELECT. The
// rollback must restore the active rows, the memberships, the revision and
// dirty domains the DELETE's trigger had changed, and the failure slot of
// the work domains; the promotion itself ends failed without its claim.
const rollsBackFailedReplacement = async (target, state) => {
  const rows = syntheticRows(poisonRows, 90_000);
  rows[poisonRows - 1][snapshotFields.indexOf('Timezone_new')] = null;
  const file = path.join(state.dir, 'snapshot-poison.csv');
  await writeSnapshot(file, rows);
  const id = await uploadCsv(target, {
    file,
    state,
    title: 'synthetic-snapshot-poison',
  });
  const report = await get(target, snapshotPath);
  const status = await get(target, statusPath);
  const memberships = await count(target, 'moodle_history_memberships');
  assert.equal(memberships, state.memberships);
  await setRequired(target, 'Timezone_new', true);
  let run;
  try {
    run = await runImport(target, { confirm_replace: true, file: id });
  } finally {
    await setRequired(target, 'Timezone_new', false);
  }
  assert.equal(run.status, 500, JSON.stringify(run.body));
  assert.equal(codeOf(run.body), 'SNAPSHOT_PROMOTION_FAILED');
  assert.match(messageOf(run.body), notNullPattern);
  const after = await get(target, snapshotPath);
  assert.deepEqual(after.active, report.active);
  assert.deepEqual(after.promoted, report.promoted);
  assert.equal(after.activeMatchesPromotion, true);
  assert.equal(after.state, 'failed');
  assert.ok(after.error.startsWith('SNAPSHOT_PROMOTION_FAILED'));
  assert.deepEqual(after.staging, {
    fingerprint: fingerprintOf(rows),
    rows: poisonRows,
  });
  assert.equal(await count(target, 'moodle_history_memberships'), memberships);
  assert.equal(await count(target, 'moodle_users'), previousRows);
  const settled = await get(target, statusPath);
  assert.deepEqual(settled.revisions, status.revisions);
  assert.deepEqual(settled.dirty, status.dirty);
  assert.deepEqual(settled.lastError, status.lastError);
  assert.equal(settled.claim, null);
};

// The full-size snapshot through the installed Flow while a second client
// polls the active count, the import state and the snapshot report: every
// count it sees is the complete old or the complete new snapshot, and the
// report answers throughout, showing the committed staging while the
// import runs.
const promotesFullSnapshot = async (target, state, t) => {
  const rows = syntheticRows(bigRows);
  const file = path.join(state.dir, 'snapshot-b.csv');
  const timings = {};
  let mark = performance.now();
  await writeSnapshot(file, rows);
  timings.generateMs = Math.round(performance.now() - mark);
  mark = performance.now();
  const id = await uploadCsv(target, {
    file,
    state,
    title: 'synthetic-snapshot-b',
  });
  timings.uploadMs = Math.round(performance.now() - mark);
  const before = await get(target, statusPath);
  const observed = [];
  const reading = { on: true };
  const started = performance.now();
  const timedReport = async () => {
    const asked = performance.now();
    const answer = await get(target, snapshotPath);
    return { ms: Math.round(performance.now() - asked), report: answer };
  };
  const reader = (async () => {
    while (reading.on) {
      const [users, singleton, reported] = await Promise.all([
        count(target, 'moodle_users'),
        get(target, '/items/data_operations?fields=import_state'),
        timedReport(),
      ]);
      observed.push({
        at: Math.round(performance.now() - started),
        reportMs: reported.ms,
        reportState: reported.report.state,
        staging: reported.report.staging.rows,
        state: singleton.import_state,
        users,
      });
      await delay(25);
    }
  })();
  const run = await runImport(target, { confirm_replace: true, file: id });
  timings.flowMs = Math.round(performance.now() - started);
  reading.on = false;
  await reader;
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 1_500));
  const counts = [...new Set(observed.map(({ users }) => users))];
  assert.ok(
    counts.every((value) => value === previousRows || value === bigRows),
    `a reader saw ${counts.join(', ')}`,
  );
  assert.ok(observed.length > 20 && observed[0]?.users === previousRows);
  const importing = observed.filter(({ reportState }) =>
    ['importing', 'validating'].includes(reportState),
  );
  assert.ok(importing.length > 0, 'the report answered while importing');
  assert.ok(
    importing.every(({ staging }) => staging === poisonRows),
    `while importing the report saw staging ${[...new Set(importing.map(({ staging }) => staging))].join(', ')}`,
  );
  const stagingSeen = [...new Set(observed.map(({ staging }) => staging))];
  assert.ok(
    stagingSeen.every((value) => [0, bigRows, poisonRows].includes(value)),
    `the report saw staging ${stagingSeen.join(', ')}`,
  );
  const first = (value) =>
    observed.find(({ state: seen }) => seen === value)?.at ?? null;
  Object.assign(timings, {
    observations: observed.length,
    promotingAtMs: first('promoting'),
    reportMaxMs: Math.max(...observed.map(({ reportMs }) => reportMs)),
    reportsWhileImporting: importing.length,
    stagedReadyAtMs: first('ready'),
    states: [...new Set(observed.map(({ state: seen }) => seen))],
  });
  assert.equal(run.body.state, 'completed');
  assert.equal(run.body.rows, bigRows);
  assert.equal(run.body.previousRows, previousRows);
  assert.equal(run.body.fingerprint, fingerprintOf(rows));
  assert.equal(run.body.membershipsRemoved, state.memberships);
  assert.deepEqual(run.body.warnings, {
    historyLinesOverLimit: {
      count: 2,
      rows: longLineRows.map((index) => index + 1),
    },
  });
  assert.deepEqual(run.body.backup.rows, previousRows);
  assert.equal(run.body.backup.fingerprint, state.previous.fingerprint);
  assert.deepEqual(run.body.pending, allDomains);
  Object.assign(state, { backup: run.body.backup.file });
  const report = await get(target, snapshotPath);
  assert.deepEqual(report.active, {
    fingerprint: fingerprintOf(rows),
    rows: bigRows,
  });
  assert.equal(report.activeMatchesPromotion, true);
  assert.equal(report.promoted.fingerprint, fingerprintOf(rows));
  assert.equal(report.promoted.rows, bigRows);
  assert.equal(report.staging.rows, 0);
  assert.match(report.warnings, warningPattern);
  assert.equal(await count(target, 'moodle_history_memberships'), 0);
  assert.equal(await count(target, 'moodle_course_entries'), state.entries);
  const mapping = await get(
    target,
    `/items/moodle_course_mappings/${state.mapping}?fields=entry`,
  );
  assert.equal(mapping.entry, state.entry);
  const entry = await get(
    target,
    `/items/moodle_course_entries/${state.entry}?fields=first_seen`,
  );
  assert.equal(typeof state.firstSeen, 'string');
  assert.equal(entry.first_seen, state.firstSeen);
  const status = await get(target, statusPath);
  assert.deepEqual(status.dirty, allDomains);
  assert.ok(status.revisions.source > before.revisions.source);
  assert.equal(status.claim, null);
  for (const index of sampled) {
    const [stored] = await get(
      target,
      `/items/moodle_users?fields=${fieldsQuery}&sort=id&offset=${index}&limit=1`,
    );
    assertRawRows([stored], [rows[index]], `sampled row ${index}`);
  }
  Object.assign(state, {
    big: { fingerprint: report.active.fingerprint, rows },
    timings,
  });
  t.diagnostic(`timings ${JSON.stringify(timings)}`);
};

// Readiness can tell when the active rows no longer equal the promoted
// snapshot: an edit outside the workflow flips the flag, a later import
// that fails (here: a CSV outside the private folder) does not hide it,
// and undoing the edit restores the exact fingerprint whatever the import
// state.
const detectsOutsideEdits = async (target, state) => {
  const [first] = await get(
    target,
    '/items/moodle_users?fields=id,Name&sort=id&limit=1',
  );
  const edit = (Name) =>
    call(target, `/items/moodle_users/${first.id}`, {
      body: JSON.stringify({ Name }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    });
  const changed = await edit('Synthetic Outside Edit');
  assert.equal(changed.status, 200);
  const edited = await get(target, snapshotPath);
  assert.equal(edited.activeMatchesPromotion, false);
  const outside = await uploadCsv(target, {
    file: path.join(state.dir, 'snapshot-a.csv'),
    folder: null,
    state,
    title: 'synthetic-outside-folder',
  });
  const refused = await runImport(target, {
    confirm_replace: true,
    file: outside,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(codeOf(refused.body), 'SNAPSHOT_FILE_INVALID');
  assert.match(messageOf(refused.body), folderPattern);
  const failed = await get(target, snapshotPath);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fingerprint, null);
  assert.equal(failed.activeMatchesPromotion, false);
  assert.equal(failed.promoted.fingerprint, state.big.fingerprint);
  assert.equal(failed.promoted.rows, bigRows);
  const undone = await edit(first.Name);
  assert.equal(undone.status, 200);
  const restored = await get(target, snapshotPath);
  assert.equal(restored.state, 'failed');
  assert.equal(restored.activeMatchesPromotion, true);
};

const keepsBackup = async (target, state) => {
  const meta = await get(
    target,
    `/files/${state.backup}?fields=storage,type,title,folder`,
  );
  assert.equal(meta.storage, 'local');
  assert.equal(meta.folder, snapshotFolder.id);
  assert.equal(meta.type, 'text/csv');
  assert.ok(meta.title.startsWith(backupTitlePrefix));
  const download = await fetch(
    new URL(`/assets/${state.backup}`, target.base),
    {
      headers: { authorization: `Bearer ${target.token}` },
    },
  );
  assert.equal(download.status, 200);
  const records = [];
  const text = await download.text();
  const reader = readCsv([text], { maxCellChars: 1_000_000, maxCells: 38 });
  for await (const record of reader) {
    records.push(record);
  }
  assert.deepEqual(records[0]?.cells, [...snapshotFields]);
  assert.equal(records.length - 1, previousRows);
  const restage = await triggerProbe(target, probeImportFlowId, {
    body: {
      file: state.backup,
    },
  });
  assert.equal(restage.status, 200, JSON.stringify(restage.body));
  assert.equal(restage.body.rows, previousRows);
  assert.equal(restage.body.fingerprint, state.previous.fingerprint);
  assert.equal(await count(target, 'moodle_users'), bigRows);
};

const refusesLateRows = async (target, state) => {
  // Row 29,990 repeats the new-instance id of row 6 (both carry ID_new only).
  const duplicate = [...state.big.rows[29_990]];
  duplicate[1] = state.big.rows[6][1];
  const cases = [
    [
      'late-duplicate',
      new Map([[29_990, csvRecord(duplicate)]]),
      'SNAPSHOT_INVALID_ROWS',
      lateDuplicatePattern,
    ],
    [
      'late-quote',
      new Map([[29_999, '1,"Unterminated synthetic late row\n']]),
      'SNAPSHOT_INVALID_CSV',
      lateQuotePattern,
    ],
  ];
  for (const [name, raw, code, pattern] of cases) {
    const file = path.join(state.dir, `snapshot-${name}.csv`);
    await writeSnapshot(file, state.big.rows, raw);
    const id = await uploadCsv(target, {
      file,
      state,
      title: `synthetic-${name}`,
    });
    const before = await get(target, statusPath);
    const run = await runImport(target, { confirm_replace: true, file: id });
    assert.equal(run.status, 400, JSON.stringify(run.body).slice(0, 1_500));
    assert.equal(codeOf(run.body), code);
    assert.match(messageOf(run.body), pattern);
    assert.doesNotMatch(messageOf(run.body), syntheticTextPattern);
    const report = await get(target, snapshotPath);
    assert.deepEqual(report.active, {
      fingerprint: state.big.fingerprint,
      rows: bigRows,
    });
    assert.equal(report.state, 'failed');
    assert.ok(report.error.startsWith(code));
    const after = await get(target, statusPath);
    assert.equal(after.revisions.source, before.revisions.source);
  }
};

// Millions of empty lines are read in constant memory by the running
// Directus: between two rows they are refused at the first of them, at the
// end of the file they are ignored.
const handlesEmptyLines = async (target, state) => {
  const blanks = '\n'.repeat(blankLines);
  const [one, two] = state.big.rows;
  const inner = path.join(state.dir, 'snapshot-inner-blanks.csv');
  await writeFile(
    inner,
    `${csvHeader}${csvRecord(one)}${blanks}${csvRecord(two)}`,
  );
  const firstBlank = `${csvHeader}${csvRecord(one)}`.split('\n').length;
  const innerId = await uploadCsv(target, {
    file: inner,
    state,
    title: 'synthetic-inner-blanks',
  });
  const refused = await runImport(target, {
    confirm_replace: true,
    file: innerId,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(codeOf(refused.body), 'SNAPSHOT_INVALID_CSV');
  assert.equal(
    messageOf(refused.body),
    `Invalid CSV: empty line on line ${firstBlank}`,
  );
  const report = await get(target, snapshotPath);
  assert.deepEqual(report.active, {
    fingerprint: state.big.fingerprint,
    rows: bigRows,
  });
  const trailing = path.join(state.dir, 'snapshot-trailing-blanks.csv');
  await writeFile(
    trailing,
    `${csvHeader}${csvRecord(one)}${csvRecord(two)}${blanks}`,
  );
  const trailingId = await uploadCsv(target, {
    file: trailing,
    state,
    title: 'synthetic-trailing-blanks',
  });
  const staged = await triggerProbe(target, probeImportFlowId, {
    body: { file: trailingId },
  });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.rows, 2);
  assert.equal(staged.body.fingerprint, fingerprintOf([one, two]));
  assert.equal(await count(target, 'moodle_users'), bigRows);
};

const confirmsEmptySnapshot = async (target, state) => {
  const file = path.join(state.dir, 'snapshot-empty.csv');
  await writeFile(file, csvHeader);
  const id = await uploadCsv(target, {
    file,
    state,
    title: 'synthetic-snapshot-empty',
  });
  const refused = await runImport(target, { confirm_replace: true, file: id });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(codeOf(refused.body), 'SNAPSHOT_EMPTY_NOT_CONFIRMED');
  assert.equal(await count(target, 'moodle_users'), bigRows);
  const emptied = await runImport(target, {
    allow_empty: true,
    confirm_replace: true,
    file: id,
  });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
  assert.equal(emptied.body.rows, 0);
  assert.equal(emptied.body.previousRows, bigRows);
  assert.equal(emptied.body.backup.rows, bigRows);
  assert.equal(await count(target, 'moodle_users'), 0);
  const report = await get(target, snapshotPath);
  assert.equal(report.promoted.rows, 0);
  assert.equal(report.activeMatchesPromotion, true);
};

// Removes everything the run recorded, whichever step it reached: an item
// that is already gone is fine, any other outcome is collected and
// reported once everything else was tried; the generated CSVs are removed
// in every case.
const cleansUp = async (target, state) => {
  const failures = [];
  const attempt = async (pathname) => {
    const failure = await removeIfPresent(target, pathname);
    if (failure !== null) failures.push(failure);
  };
  try {
    const ours = [...state.probes, ...state.flowsCreated];
    for (const id of ours) await attempt(`/flows/${id}`);
    const backups = await get(
      target,
      `/files?fields=id&filter[title][_starts_with]=${backupTitlePrefix}&limit=-1`,
    );
    const created = new Set([
      ...state.files,
      ...backups
        .map(({ id }) => id)
        .filter((id) => !state.backupsBefore.has(id)),
    ]);
    for (const id of created) await attempt(`/files/${id}`);
    if (state.folderCreated) await attempt(`/folders/${snapshotFolder.id}`);
    const flows = await get(target, '/flows?fields=id&limit=-1');
    assert.deepEqual(
      flows.filter(({ id }) => ours.includes(id)),
      [],
      'every flow of this run is gone',
    );
    const left = await get(
      target,
      `/files?fields=id&filter[id][_in]=${[...created].join(',') || 'none'}&limit=-1`,
    );
    assert.deepEqual(left, []);
  } finally {
    await rm(state.dir, { force: true, recursive: true });
  }
  assert.deepEqual(failures, []);
};

test('stages and activates Moodle snapshots safely', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {
    backupsBefore: new Set(),
    dir: await mkdtemp(path.join(os.tmpdir(), 'snapshot-import-')),
    files: [],
    flowsCreated: [],
    folderCreated: false,
    probes: [],
    timings: {},
  };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await applySourceInvalidation(directus);
      await t.test('installs the snapshot import Flow once', () =>
        installsFlow(target, directus, state),
      );
      await t.test(
        'stages, promotes and indexes a first synthetic snapshot',
        () => promotesFirstSnapshot(target, state),
      );
      await t.test(
        'refuses direct staging writes, unconfirmed runs and refused callers',
        (sub) => refusesDirectAndUnauthorised(target, state, sub),
      );
      await t.test(
        'rolls a replacement that fails after its deletes back on the database',
        () => rollsBackFailedReplacement(target, state),
      );
      await t.test(
        'promotes the 30,000-row snapshot atomically while a reader polls',
        (sub) => promotesFullSnapshot(target, state, sub),
      );
      await t.test(
        'reports active rows changed outside the snapshot workflow, through later imports',
        () => detectsOutsideEdits(target, state),
      );
      await t.test(
        'keeps a verified, restorable backup of the replaced snapshot',
        () => keepsBackup(target, state),
      );
      await t.test(
        'refuses late malformed rows and leaves the active snapshot untouched',
        () => refusesLateRows(target, state),
      );
      await t.test(
        'reads millions of empty lines in constant memory, refusing them between rows',
        () => handlesEmptyLines(target, state),
      );
      await t.test(
        'replaces with an empty snapshot only when that is confirmed separately',
        () => confirmsEmptySnapshot(target, state),
      );
    } finally {
      await t.test('removes the flows and files it created', () =>
        cleansUp(target, state),
      );
    }
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
