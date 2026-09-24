import type { Inventory } from './inventory.js';

import { findModelCollection } from '../data-model/collections.js';
import { isLegacyFlow } from '../legacy-flows.js';
import { type CollectionKey, collectionKeys } from '../schema.js';
import { academicYears as checkpointYears } from '../specs/public.js';
import { isBlocker, sortFindings } from './findings.js';
import { fingerprintInventory } from './fingerprint.js';
import { finding, listIds, quote } from './labels.js';
import { courseCandidates } from './preflight-courses.js';
import { buildIndexes } from './preflight-indexes.js';
import { buildMappings } from './preflight-mappings.js';
import { rowCandidates } from './preflight-rows.js';
import {
  type CourseCandidate,
  type Finding,
  type LedgerSummary,
  type MigrationReport,
  migrationVersion,
} from './report.js';

const flowSummaries = (
  inventory: Inventory,
): {
  readonly findings: readonly Finding[];
  readonly flows: MigrationReport['flows'];
} => {
  const flows = inventory.flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    operationTypes: inventory.operations
      .filter((operation) => operation.flow === flow.id)
      .map(({ type }) => type),
    status: flow.status,
    trigger: flow.trigger,
  }));
  const findings = flows.map((flow) => {
    const base = { collection: 'directus_flows', ids: [], label: flow.id };
    return isLegacyFlow(flow.id, flow.operationTypes)
      ? finding('legacy_flow_present', {
          ...base,
          message: `Flow ${quote(flow.name)} (${flow.status}) runs the checkpoint derivation or publication (${flow.operationTypes.join(', ')}); it must be retired or re-pointed at cutover, never overwritten by the migration.`,
        })
      : finding('persisted_flow', {
          ...base,
          message: `Flow ${quote(flow.name)} (${flow.status}, ${flow.trigger ?? 'no trigger'}) is user-edited and is preserved; review it against the relational model at cutover.`,
        });
  });
  return { findings, flows };
};

// Curriculum rows no course resolves to: retained, listed for review.
const unreferencedFindings = (
  inventory: Inventory,
  courses: readonly CourseCandidate[],
): readonly Finding[] => {
  const referenced = {
    curriculum_2018: new Set(
      courses.flatMap((course) => course.legacy.entry.matches),
    ),
    curriculum_2023: new Set(
      courses.flatMap((course) => course.current.matches),
    ),
  } as const;
  return (['curriculum_2018', 'curriculum_2023'] as const).flatMap(
    (collection) => {
      const ids = inventory.checkpoint[collection]
        .map(({ id }) => id)
        .filter((id) => !referenced[collection].has(id));
      return ids.length === 0
        ? []
        : [
            finding('unreferenced_rows', {
              collection,
              ids,
              label: null,
              message: `${collection} rows ${listIds(ids)} are resolved by no course; they become curriculum entries without a course link and stay under review.`,
            }),
          ];
    },
  );
};

// A column the checkpoint model and the relational model both leave
// undeclared holds data no converter copies; the row keeps it, but the
// reviewer must decide whether the relational model has to carry it.
const knownColumns = (collection: CollectionKey): ReadonlySet<string> =>
  new Set([
    'id',
    ...(findModelCollection(collection)?.fields.map(({ field }) => field) ??
      []),
  ]);

const fieldFindings = (inventory: Inventory): readonly Finding[] =>
  collectionKeys.flatMap((collection) => {
    const known = knownColumns(collection);
    return inventory.fields[collection]
      .filter((column) => !known.has(column))
      .map((column) =>
        finding('unknown_source_field', {
          collection,
          ids: [],
          label: column,
          message: `${collection} carries a column ${quote(column)} that neither the checkpoint model nor the relational model declares; the migration copies nothing from it. Review whether it holds data the relational model must carry before cutover.`,
        }),
      );
  });

const targetFindings = (inventory: Inventory): readonly Finding[] => {
  if (inventory.targets === null) {
    return [
      finding('model_not_installed', {
        collection: 'curriculum_entries',
        ids: [],
        label: null,
        message:
          'The relational collections are not readable (not installed yet, or the token cannot read them); run npm run setup before --apply, which refuses in this state. The dry-run inspected the checkpoint rows only.',
      }),
    ];
  }
  const unprovenanced = inventory.targets.curriculum_entries
    .filter((row) => row.source_collection === null || row.source_id === null)
    .map(({ id }) => id);
  return unprovenanced.length === 0
    ? []
    : [
        finding('unprovenanced_target_rows', {
          collection: 'curriculum_entries',
          ids: unprovenanced,
          label: null,
          message: `curriculum_entries rows ${listIds(unprovenanced)} carry no checkpoint provenance; the migration never touches them and a converter must not treat them as its own output.`,
        }),
      ];
};

const targetCounts = (
  targets: Inventory['targets'],
): MigrationReport['targets'] =>
  targets === null
    ? null
    : {
        academic_years: targets.academic_years.length,
        course_curricula: targets.course_curricula.length,
        course_enrollment_rules: targets.course_enrollment_rules.length,
        curriculum_entries: targets.curriculum_entries.length,
      };

// The academic years a populated project converts, newest first: every
// year its checkpoint counts and every academic_years row it holds. The
// one-time import seeds its workbook's years before converting, so
// `npm run migrate`, finishing a blocked or interrupted import, converts
// exactly the years the import would have; a year added in Studio since is
// converted like them. Labels such as 2025/2026 order chronologically.
export const projectYears = (targets: Inventory['targets']): string[] =>
  [
    ...new Set([
      ...checkpointYears,
      ...(targets?.academic_years ?? []).flatMap(({ label }) =>
        label === null ? [] : [label],
      ),
    ]),
  ].toSorted((left, right) => Number(left < right) - Number(left > right));

// Pure: inspects an inventory and reports every candidate decision, blocker,
// warning and planned mapping without touching the network. The academic
// years to seed, newest first, are the workbook's for the one-time import
// and, for a populated project, the years it holds (projectYears).
export const preflight = (
  inventory: Inventory,
  ledger: LedgerSummary | null,
  academicYears: readonly string[] = projectYears(inventory.targets),
): MigrationReport => {
  const indexes = buildIndexes(inventory.checkpoint);
  const courses = courseCandidates(inventory.checkpoint, {
    academicYears,
    indexes,
  });
  const rows = rowCandidates(inventory.checkpoint, indexes, academicYears);
  const flows = flowSummaries(inventory);
  const findings = sortFindings([
    ...courses.findings,
    ...rows.findings,
    ...flows.findings,
    ...unreferencedFindings(inventory, courses.candidates),
    ...fieldFindings(inventory),
    ...targetFindings(inventory),
  ]);
  const blockers = findings.filter(({ code }) => isBlocker(code));
  const { checkpoint } = inventory;
  return {
    academicYears,
    blockers,
    candidates: { courses: courses.candidates, ...rows.candidates },
    counts: {
      collections: {
        course_enrollment_patterns:
          checkpoint.course_enrollment_patterns.length,
        course_equivalencies: checkpoint.course_equivalencies.length,
        courses: checkpoint.courses.length,
        curriculum_2018: checkpoint.curriculum_2018.length,
        curriculum_2023: checkpoint.curriculum_2023.length,
        deans_office: checkpoint.deans_office.length,
        discord_channels: checkpoint.discord_channels.length,
        moodle_users: checkpoint.moodle_users.length,
        rooms: checkpoint.rooms.length,
        staff: checkpoint.staff.length,
        student_council: checkpoint.student_council.length,
        students: checkpoint.students.length,
        teaching_assignments: checkpoint.teaching_assignments.length,
      },
      flows: inventory.flows.length,
      operations: inventory.operations.length,
    },
    fields: inventory.fields,
    flows: flows.flows,
    ledger,
    mappings: buildMappings(inventory, {
      academicYears,
      courses: courses.candidates,
      rows: rows.candidates,
    }),
    migratable: blockers.length === 0,
    sourceFingerprint: fingerprintInventory(inventory),
    targets: targetCounts(inventory.targets),
    version: migrationVersion,
    warnings: findings.filter(({ code }) => !isBlocker(code)),
  };
};
