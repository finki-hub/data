import type { CourseStatus } from '../../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import type { LinkCandidate } from './labels.js';
import type { Origin } from './planned.js';
import type { TeachingLink } from './teaching-cells.js';

// The decisions the up-front check takes for every workbook row that
// links to another by label; the planners (plan.ts) write exactly these.

// The teaching of a course: its status and its staff links, professors
// then assistants in cell order, read from `source`, the cells of its
// export row with typed professors or of its first Наставен Кадар row
// (null without either: Active, linking nobody).
export type TeachingCandidate = {
  readonly links: readonly TeachingLink[];
  readonly source: null | Origin;
  readonly status: CourseStatus;
};

// The typed Слушатели pattern of a course and academic year: the last
// pattern the workbook names for them (every row naming one is in
// `overrides`), as the cell holds it, or null when none does and the year
// falls to the course's all-years mappings.
export type PatternCandidate = {
  readonly academicYear: string;
  readonly overrides: readonly number[];
  readonly pattern: null | string;
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
  readonly patterns: readonly PatternCandidate[];
  readonly teaching: TeachingCandidate;
};

export type Candidates = {
  // Every channel row and course row its Предмет cell names, once per
  // pair (ordinals); a course may have several channels.
  readonly channels: ReadonlyArray<{
    readonly channel: number;
    readonly course: number;
  }>;
  readonly council: ReadonlyArray<{
    readonly id: number;
    readonly student: LinkCandidate;
  }>;
  readonly courses: readonly CourseCandidate[];
  // The staff row each Деканат row names (ordinals); a row naming none or
  // several has none and is not planned.
  readonly deans: ReadonlyArray<{
    readonly id: number;
    readonly staff: number;
  }>;
  readonly equivalencies: ReadonlyArray<{
    readonly course: LinkCandidate;
    readonly entry2018: LinkCandidate;
    readonly entry2023: LinkCandidate;
    readonly id: number;
  }>;
};
