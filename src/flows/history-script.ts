import {
  payloadRefusal,
  refuseFragment,
  relayFragment,
} from './text-fragments.js';

// The Run Script bodies of the Moodle history index Flows. Each runs inside
// the isolated Directus script sandbox (no imports, no services, the whole
// data chain as `data`) and returns structured-clone-able values only. The
// unit suite executes every constant in node:vm against the shared history
// vector, so the splitting rule below never drifts from
// `splitHistoryEntries` in the data-operations bundle.

// Splits every raw `Courses` history of the page into its distinct exact
// entries: complete LF/CRLF-separated lines, a trailing lone CR dropped,
// empty lines ignored, first occurrence kept. Nothing is trimmed or folded.
export const splitEntriesScript = String.raw`module.exports = function (data) {
  ${refuseFragment}
  const rows = data.read_histories;
  if (!Array.isArray(rows)) {
    refuse('read_histories', 'no row list');
  }
  return rows.map(function (row) {
    const entries = [];
    const seen = new Set();
    const history = typeof row.Courses === 'string' ? row.Courses : '';
    for (const rawLine of history.split(/\r?\n/)) {
      const line = rawLine.replace(/\r$/, '');
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line);
        entries.push(line);
      }
    }
    return { entries: entries, id: row.id };
  });
};`;

// Attaches the claim token to every planned page so the page Flow, whose
// trigger data is the page element alone, can address the coordinator.
export const pagesWithTokenScript = `module.exports = function (data) {
  ${refuseFragment}
  const plan = data.plan_pages;
  if (!plan || !Array.isArray(plan.pages)) {
    refuse('plan_pages', 'no page list');
  }
  const claim = data.$trigger ? data.$trigger.token : undefined;
  if (typeof claim !== 'string' || claim.length === 0) {
    ${payloadRefusal(['token'])}
  }
  return plan.pages.map(function (page) {
    return { claim: claim, from: page.from, rows: page.rows, to: page.to, token: page.token };
  });
};`;

// Sums the page results; a page that answered with a failure record or
// nothing at all is listed under failed and turns the run's ok flag off.
export const summaryScript = `module.exports = function (data) {
  const results = Array.isArray(data.index_pages) ? data.index_pages : [];
  const summary = { entriesCreated: 0, failed: [], membershipsWritten: 0, ok: true, pages: results.length, users: 0 };
  for (const result of results) {
    if (result === null || typeof result !== 'object') {
      summary.failed.push({ code: 'NO_RESULT', ok: false });
    } else if (result.ok === false || typeof result.users !== 'number') {
      summary.failed.push(result);
    } else {
      summary.entriesCreated += result.entriesCreated;
      summary.membershipsWritten += result.membershipsWritten;
      summary.users += result.users;
    }
  }
  summary.ok = summary.failed.length === 0;
  return summary;
};`;

// The bounded message of a failed run: the first failure relayed with its
// place (a page, or the run itself), stage and code, cut to a fixed length,
// then how many pages failed when more than one did. The page records name
// the refused Moodle user when the coordinator did, so the operator knows
// whose raw history to fix without reading any log.
export const describeFailureScript = `module.exports = function (data) {
  ${relayFragment}
  const index = data.index;
  const failed = index && Array.isArray(index.failed) ? index.failed : [];
  const first = failed.length > 0 ? failed[0] : index;
  const record = first !== null && typeof first === 'object' ? first : {};
  const subject = typeof record.page === 'string' ? 'Page ' + record.page : 'Run';
  const cause = {
    code: record.code === undefined || record.code === null ? 'NO_RESULT' : record.code,
    message: record.message === undefined || record.message === null ? 'no result' : record.message,
    stage: record.stage,
  };
  const more = failed.length > 1 ? '; failed pages: ' + failed.length : '';
  return relayed(subject, cause) + more;
};`;
