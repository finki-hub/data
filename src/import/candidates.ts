import type { assignmentRoles } from '../data-model/content-collections.js';
import type { LinkCandidate } from './labels.js';

// The decisions the up-front check takes for every workbook row that
// links to another by label; the planners (plan.ts) write exactly these.

// The staff rows a professor or assistant text points at, in the order the
// text lists them: linked only when `unique`; `ambiguous` carries the ids
// in contention and links none; `unresolved` keeps the text as display
// text; `none` is an empty text.
export type StaffCandidate = {
  readonly resolution: 'ambiguous' | 'none' | 'unique' | 'unresolved';
  readonly role: (typeof assignmentRoles)[number];
  readonly staff: readonly number[];
  readonly text: null | string;
};

// The enrollment rule of a course and academic year: the last pattern the
// workbook names for them (every row naming one is in `overrides`), else
// the `<name>-<year>` default.
export type RuleCandidate = {
  readonly academicYear: string;
  readonly overrides: readonly number[];
  readonly pattern: string;
  readonly source: 'default' | 'override';
  readonly valid: boolean;
};

// The 2018 curriculum name of a course: its override, else the 2018
// label of the first equivalency row of its name.
export type LegacyCandidate = {
  readonly entry: LinkCandidate;
  readonly equivalencies: LinkCandidate;
  readonly source: 'equivalency' | 'none' | 'override';
};

export type CourseCandidate = {
  readonly current: LinkCandidate;
  readonly id: number;
  readonly legacy: LegacyCandidate;
  readonly rules: readonly RuleCandidate[];
};

export type Candidates = {
  readonly assignments: ReadonlyArray<{
    readonly course: LinkCandidate;
    readonly id: number;
    readonly staff: readonly StaffCandidate[];
  }>;
  readonly council: ReadonlyArray<{
    readonly id: number;
    readonly student: LinkCandidate;
  }>;
  readonly courses: readonly CourseCandidate[];
  readonly equivalencies: ReadonlyArray<{
    readonly course: LinkCandidate;
    readonly entry2018: LinkCandidate;
    readonly entry2023: LinkCandidate;
    readonly id: number;
  }>;
};
