import type { CoordinatorInput } from './coordination/options.js';
import type { CoordinationPort } from './coordination/port.js';
import type { OperationsState } from './coordination/state.js';

import {
  type ActionContext,
  done,
  guarded,
  mismatch,
  type Outcome,
  overtaken,
} from './coordination/action-support.js';
import { decideStage } from './coordination/decisions.js';
import { coordinationError } from './coordination/errors.js';
import { domainMismatch, pageUnplanned } from './coordination/refusals.js';
import {
  duplicateUserIds,
  missingLabels,
  pageCoverage,
  pageLabels,
  planMemberships,
} from './history-contract.js';
import { listText } from './text.js';

// Counts only: the writer never returns a label, a user or an entry.
type IndexPageResult = {
  readonly entriesCreated: number;
  readonly membershipsRemoved: number;
  readonly membershipsWritten: number;
  readonly page: string;
  readonly users: number;
};

type Input = Extract<CoordinatorInput, { action: 'index_page' }>;

// The page must be planned under a live history_index claim of this
// process; anything else is refused before a row is touched.
const verifyHistoryPage = (
  state: OperationsState,
  input: Input,
  context: ActionContext,
): null | Outcome<never> => {
  const decision = decideStage(state, {
    owner: context.owner,
    page: input.page,
    token: input.token,
  });
  if (decision.kind === 'source_changed') {
    return overtaken(decision.kind);
  }
  if (decision.kind === 'page_unplanned') {
    throw pageUnplanned(input.page);
  }
  if (decision.kind !== 'ok' || state.claim === null) {
    throw mismatch(decision.kind === 'ok' ? 'claim_mismatch' : decision.kind);
  }
  if (state.claim.domain !== 'history_index') {
    throw domainMismatch({
      actual: state.claim.domain,
      expected: 'history_index',
      subject: 'index_page',
    });
  }
  return null;
};

// The page must name exactly the users its planned range holds at the
// claimed revision (no source statement on moodle_users can have committed
// since, or the claim would be overtaken). A Read Data step whose limit
// Directus capped (QUERY_LIMIT_MAX) or a hand-built payload would otherwise
// be staged as if the whole range were indexed.
const verifyCoverage = async (
  port: CoordinationPort,
  state: OperationsState,
  input: Input,
): Promise<void> => {
  const range = state.claim?.ranges.find(({ token }) => token === input.page);
  if (range === undefined) {
    throw coordinationError(
      'PAGE_INCOMPLETE',
      `Page ${input.page} planned without user range`,
    );
  }
  const planned = await port.history.userIdsBetween(range.from, range.to);
  const { missing, unexpected } = pageCoverage(
    planned,
    input.rows.map(({ id }) => id),
  );
  if (missing > 0 || unexpected > 0) {
    throw coordinationError(
      'PAGE_INCOMPLETE',
      `Page ${input.page} incomplete: ids ${String(range.from)}-${String(range.to)}, planned ${String(planned.length)}, missing ${String(missing)}, unexpected ${String(unexpected)}`,
      { details: { missing, planned: planned.length, unexpected } },
    );
  }
};

// Every label of the page gets an entry id. Labels without an entry are
// created as needs_mapping in one statement; an existing entry is never
// updated. The entries table is a source table, so that statement's
// trigger bumps the source revision inside this very transaction: under
// the singleton lock nothing else can have moved it, and rows that only
// wait for a mapping cannot change this index, so the claim adopts the
// revision its own statement caused.
const ensureEntries = async (
  port: CoordinationPort,
  labels: readonly string[],
  claim: { readonly owner: string; readonly token: string },
): Promise<{ created: number; ids: Map<string, number> }> => {
  const ids = new Map<string, number>();
  const known = await port.history.entriesByLabel(labels);
  for (const entry of known) {
    ids.set(entry.label, entry.id);
  }
  const missing = missingLabels(labels, ids);
  if (missing.length === 0) {
    return { created: 0, ids };
  }
  const created = await port.history.createEntries(missing);
  if (!(await port.adoptOwnRevision(claim.token, claim.owner))) {
    throw mismatch('claim_mismatch');
  }
  const fresh = await port.history.entriesByLabel(missing);
  for (const entry of fresh) {
    ids.set(entry.label, entry.id);
  }
  return { created, ids };
};

// Replaces the memberships of exactly the users of the planned range
// inside one transaction: delete by user, insert the unique pairs in
// first-occurrence order, record the page as staged. Only this transaction
// opens the membership write guard. Entries and mappings are never
// deleted, so a label that later snapshots no longer contain keeps its
// review state and its manual mappings.
export const indexPageAction = (
  input: Input,
  context: ActionContext,
): Promise<IndexPageResult> =>
  guarded(context, input.token, async (port) => {
    const duplicates = duplicateUserIds(input.rows);
    if (duplicates.length > 0) {
      throw coordinationError(
        'DUPLICATE_ROWS',
        `Duplicate Moodle users: ${listText(duplicates.map(String))}`,
        { status: 400 },
      );
    }
    const state = await port.readState(true);
    const refusal = verifyHistoryPage(state, input, context);
    if (refusal !== null) {
      return refusal;
    }
    await verifyCoverage(port, state, input);
    const labels = pageLabels(input.rows);
    const { created, ids } = await ensureEntries(port, labels, {
      owner: context.owner,
      token: input.token,
    });
    const memberships = planMemberships(input.rows, ids);
    await port.history.openWriter();
    const removed = await port.history.deleteMemberships(
      input.rows.map(({ id }) => id),
    );
    const written =
      memberships.length === 0
        ? 0
        : await port.history.insertMemberships(memberships);
    if (
      !(await port.recordStagedPage(input.token, context.owner, input.page))
    ) {
      throw mismatch('claim_mismatch');
    }
    return done({
      entriesCreated: created,
      membershipsRemoved: removed,
      membershipsWritten: written,
      page: input.page,
      users: input.rows.length,
    });
  });
