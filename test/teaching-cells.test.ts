import { describe, expect, test } from 'vitest';

import {
  type AssignmentRole,
  assistantsText,
  type CourseStatus,
  professorsText,
} from '../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import { indexLabels } from '../src/import/labels.js';
import {
  type TeachingCells,
  teachingCells,
  type TeachingFinding,
  type TeachingFindingCode,
  type TeachingLink,
} from '../src/import/teaching-cells.js';

// How a course's professors and assistants cells become its status and its
// staff links: one row of the decision table per rule. Names are matched
// exactly, line by line; every case is a finding without a value.

const one = 'Synthetic Staff One';
const two = 'Synthetic Staff Two';
const three = 'Synthetic Staff Three';
const namesake = 'Synthetic Namesake';
const twin = 'Synthetic Twin';
const unknown = 'Synthetic Unknown';
const other = 'Synthetic Other Unknown';

const allProfessors = 'Сите професори';
const inactive = '(неактивиран предмет)';

// Staff rows by ordinal: rows 4 and 5 share a name, and so do 6 and 7.
const staffByName = indexLabels(
  [
    { id: 1, name: one },
    { id: 2, name: two },
    { id: 3, name: three },
    { id: 4, name: namesake },
    { id: 5, name: namesake },
    { id: 6, name: twin },
    { id: 7, name: twin },
  ],
  ({ name }) => name,
);

const lines = (...items: readonly string[]): string => items.join('\n');

const linked = (
  role: AssignmentRole,
  staff: number,
  line: number,
): TeachingLink => ({ line, role, staff });

const found = (
  code: TeachingFindingCode,
  role: AssignmentRole,
  cases: readonly number[],
): TeachingFinding => ({ code, lines: cases, role, staff: [] });

// An ambiguous name's finding names the staff rows in contention.
const contested = (
  role: AssignmentRole,
  cases: readonly number[],
  staff: readonly number[],
): TeachingFinding => ({
  ...found('ambiguous_staff_name', role, cases),
  staff,
});

const inactiveAssistants = found('inactive_course_assistants', 'assistant', []);

type Row = TeachingCells & {
  readonly assistants: null | string;
  readonly professors: null | string;
  readonly rule: string;
};

const row = (
  rule: string,
  cells: Pick<Row, 'assistants' | 'professors'>,
  expected: Partial<TeachingCells> & { readonly status: CourseStatus },
): Row => ({ findings: [], links: [], ...cells, ...expected, rule });

const statusRows: readonly Row[] = [
  row(
    'the Inactive text gives Inactive and links nobody',
    { assistants: null, professors: inactive },
    { status: 'inactive' },
  ),
  row(
    'Inactive accepts an empty assistants cell',
    { assistants: '', professors: inactive },
    { status: 'inactive' },
  ),
  row(
    'Inactive accepts the Inactive text as assistants',
    { assistants: inactive, professors: inactive },
    { status: 'inactive' },
  ),
  row(
    'Inactive refuses a staff name as assistants, and links nobody',
    { assistants: one, professors: inactive },
    { findings: [inactiveAssistants], status: 'inactive' },
  ),
  row(
    'Inactive refuses the All professors text as assistants',
    { assistants: allProfessors, professors: inactive },
    { findings: [inactiveAssistants], status: 'inactive' },
  ),
  row(
    'Inactive refuses a padded Inactive text as assistants',
    { assistants: ` ${inactive}`, professors: inactive },
    { findings: [inactiveAssistants], status: 'inactive' },
  ),
  row(
    'a padded Inactive text is a name, not the status',
    { assistants: null, professors: `${inactive} ` },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
  row(
    'the Inactive text followed by a line break is two names',
    { assistants: null, professors: `${inactive}\n` },
    {
      findings: [found('unmatched_staff_name', 'professor', [1, 2])],
      status: 'active',
    },
  ),
  row(
    'the All professors text gives All professors and links no professor',
    { assistants: null, professors: allProfessors },
    { status: 'all_professors' },
  ),
  row(
    'All professors links its assistants in cell order',
    { assistants: lines(two, one), professors: allProfessors },
    {
      links: [linked('assistant', 2, 1), linked('assistant', 1, 2)],
      status: 'all_professors',
    },
  ),
  row(
    'All professors checks its assistants',
    { assistants: lines(one, unknown), professors: allProfessors },
    {
      findings: [found('unmatched_staff_name', 'assistant', [2])],
      links: [linked('assistant', 1, 1)],
      status: 'all_professors',
    },
  ),
  row(
    'a padded All professors text is a name, not the status',
    { assistants: null, professors: `${allProfessors} ` },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
  row(
    'the All professors text in other case is a name, not the status',
    { assistants: null, professors: 'сите професори' },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
  row(
    'the status comes from the professors cell only',
    { assistants: inactive, professors: one },
    {
      findings: [found('unmatched_staff_name', 'assistant', [1])],
      links: [linked('professor', 1, 1)],
      status: 'active',
    },
  ),
  row(
    'All professors as assistants is a name',
    { assistants: allProfessors, professors: one },
    {
      findings: [found('unmatched_staff_name', 'assistant', [1])],
      links: [linked('professor', 1, 1)],
      status: 'active',
    },
  ),
  row(
    'two empty cells give Active without links',
    { assistants: null, professors: null },
    { status: 'active' },
  ),
  row(
    'two blank cells give Active without links',
    { assistants: '', professors: '' },
    { status: 'active' },
  ),
  row(
    'Active without professors still links its assistants',
    { assistants: one, professors: null },
    { links: [linked('assistant', 1, 1)], status: 'active' },
  ),
];

const lineRows: readonly Row[] = [
  row(
    'Active links professors, then assistants, each in cell order',
    { assistants: lines(three, one), professors: lines(two, one) },
    {
      links: [
        linked('professor', 2, 1),
        linked('professor', 1, 2),
        linked('assistant', 3, 1),
        linked('assistant', 1, 2),
      ],
      status: 'active',
    },
  ),
  row(
    'a line with a trailing space is not trimmed',
    { assistants: null, professors: lines(`${one} `, two) },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      links: [linked('professor', 2, 2)],
      status: 'active',
    },
  ),
  row(
    'a line with a leading space is not trimmed',
    { assistants: null, professors: ` ${one}` },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
  row(
    'lines split on LF only: a CR stays in the line',
    { assistants: null, professors: `${one}\r\n${two}` },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      links: [linked('professor', 2, 2)],
      status: 'active',
    },
  ),
  row(
    'an empty line inside a cell names nobody',
    { assistants: null, professors: lines(one, '', two) },
    {
      findings: [found('unmatched_staff_name', 'professor', [2])],
      links: [linked('professor', 1, 1), linked('professor', 2, 3)],
      status: 'active',
    },
  ),
  row(
    'a trailing line break gives an empty last line',
    { assistants: `${one}\n`, professors: two },
    {
      findings: [found('unmatched_staff_name', 'assistant', [2])],
      links: [linked('professor', 2, 1), linked('assistant', 1, 1)],
      status: 'active',
    },
  ),
  row(
    'a comma is no separator',
    { assistants: null, professors: `${one}, ${two}` },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
  row(
    'a name in other case is not matched',
    { assistants: null, professors: one.toUpperCase() },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
];

const linkRows: readonly Row[] = [
  row(
    'a name of exactly one staff row links that row',
    { assistants: two, professors: one },
    {
      links: [linked('professor', 1, 1), linked('assistant', 2, 1)],
      status: 'active',
    },
  ),
  row(
    'a repeat in one cell is linked once, at its first line',
    { assistants: null, professors: lines(one, two, one) },
    {
      findings: [found('repeated_staff_name', 'professor', [3])],
      links: [linked('professor', 1, 1), linked('professor', 2, 2)],
      status: 'active',
    },
  ),
  row(
    'every further repeat is a line of the same finding',
    { assistants: lines(one, one, one), professors: two },
    {
      findings: [found('repeated_staff_name', 'assistant', [2, 3])],
      links: [linked('professor', 2, 1), linked('assistant', 1, 1)],
      status: 'active',
    },
  ),
  row(
    'one person in both cells is linked in both roles',
    { assistants: one, professors: one },
    {
      links: [linked('professor', 1, 1), linked('assistant', 1, 1)],
      status: 'active',
    },
  ),
  row(
    'a name of no staff row links nothing',
    { assistants: null, professors: unknown },
    {
      findings: [found('unmatched_staff_name', 'professor', [1])],
      status: 'active',
    },
  ),
  row(
    'one unmatched finding per cell carries all its lines',
    { assistants: null, professors: lines(one, unknown, two, other) },
    {
      findings: [found('unmatched_staff_name', 'professor', [2, 4])],
      links: [linked('professor', 1, 1), linked('professor', 2, 3)],
      status: 'active',
    },
  ),
  row(
    'an unmatched name listed twice is two unmatched lines',
    { assistants: null, professors: lines(unknown, unknown) },
    {
      findings: [found('unmatched_staff_name', 'professor', [1, 2])],
      status: 'active',
    },
  ),
  row(
    'a name of several staff rows links nothing and names them',
    { assistants: null, professors: namesake },
    {
      findings: [contested('professor', [1], [4, 5])],
      status: 'active',
    },
  ),
  row(
    'one ambiguous finding per cell carries all its lines and rows',
    { assistants: lines(twin, one, namesake), professors: null },
    {
      findings: [contested('assistant', [1, 3], [4, 5, 6, 7])],
      links: [linked('assistant', 1, 2)],
      status: 'active',
    },
  ),
  row(
    'an ambiguous name listed twice is two ambiguous lines, no repeat',
    { assistants: null, professors: lines(namesake, namesake) },
    {
      findings: [contested('professor', [1, 2], [4, 5])],
      status: 'active',
    },
  ),
  row(
    'each cell reports its own cases, one finding per code',
    {
      assistants: lines(unknown, three, three),
      professors: lines(one, namesake, unknown, one),
    },
    {
      findings: [
        contested('professor', [2], [4, 5]),
        found('repeated_staff_name', 'professor', [4]),
        found('unmatched_staff_name', 'professor', [3]),
        found('repeated_staff_name', 'assistant', [3]),
        found('unmatched_staff_name', 'assistant', [1]),
      ],
      links: [linked('professor', 1, 1), linked('assistant', 3, 2)],
      status: 'active',
    },
  ),
];

const decisions = [...statusRows, ...lineRows, ...linkRows];

const resultOf = ({ assistants, professors }: Row): TeachingCells =>
  teachingCells({ assistants, professors }, staffByName);

const rolesOf = ({ links }: TeachingCells) => links.map(({ role }) => role);

const codesOf = ({ findings }: TeachingCells) =>
  findings.map(({ code }) => code);

// Staff rows by name, for the published names read back.
const staffIds = new Map([
  [one, 1],
  [three, 3],
  [two, 2],
]);

// The links that names published in a role give back, in their order.
const linksBack = (
  role: AssignmentRole,
  names: readonly string[],
): readonly TeachingLink[] =>
  names.map((name, index) => linked(role, staffIds.get(name) ?? 0, index + 1));

describe('teachingCells', () => {
  test.each(decisions)('$rule', ({ assistants, professors, ...expected }) => {
    expect({
      rule: expected.rule,
      ...teachingCells({ assistants, professors }, staffByName),
    }).toEqual(expected);
  });

  test('the table covers every status, role and finding code', () => {
    const results = decisions.map(resultOf);

    expect(new Set(results.map(({ status }) => status))).toEqual(
      new Set(['active', 'all_professors', 'inactive']),
    );
    expect(new Set(results.flatMap(rolesOf))).toEqual(
      new Set(['assistant', 'professor']),
    );
    expect(new Set(results.flatMap(codesOf))).toEqual(
      new Set([
        'ambiguous_staff_name',
        'inactive_course_assistants',
        'repeated_staff_name',
        'unmatched_staff_name',
      ]),
    );
  });

  test('a finding carries codes, roles, lines and staff rows, never a cell text', () => {
    const findings = JSON.stringify(
      decisions.map((item) => resultOf(item).findings),
    );

    for (const text of [one, two, three, namesake, twin, unknown, other]) {
      expect(findings).not.toContain(text);
    }

    expect(findings).not.toContain('Synthetic');
  });
});

describe('the published texts read back as cells', () => {
  const statuses: ReadonlyArray<{
    readonly assistants: readonly string[];
    readonly professors: readonly string[];
    readonly status: CourseStatus;
  }> = [
    { assistants: [three, one], professors: [two, one], status: 'active' },
    { assistants: [], professors: [one], status: 'active' },
    { assistants: [three], professors: [], status: 'all_professors' },
    { assistants: [], professors: [], status: 'all_professors' },
    { assistants: [], professors: [], status: 'inactive' },
  ];

  test.each(statuses)(
    '$status gives the same status and links back',
    ({ assistants, professors, status }) => {
      expect(
        teachingCells(
          {
            assistants: assistantsText(status, assistants),
            professors: professorsText(status, professors),
          },
          staffByName,
        ),
      ).toEqual({
        findings: [],
        links: [
          ...linksBack('professor', professors),
          ...linksBack('assistant', assistants),
        ],
        status,
      });
    },
  );
});
