// The vocabularies of the thesis import, declared once: the data model
// (src/data-model/thesis-collections.ts) and the import read them from
// here. Pure: it imports nothing.

// What a staff member was on a bachelor thesis.
export const bachelorRoles = ['mentor', 'member'] as const;

// What a staff member was on a master thesis.
export const masterRoles = ['mentor', 'president', 'member'] as const;

export type ThesisTable = {
  // The table of the staff members' roles on its theses.
  readonly committee: 'bachelor_thesis_staff' | 'master_thesis_staff';
  // The stored columns, as the import's rows name them.
  readonly fields: readonly string[];
  // The columns holding a staff member's name, with the role they give.
  readonly names: ReadonlyArray<readonly [role: string, column: string]>;
  readonly table: 'bachelor_theses' | 'master_theses';
};

const shared = [
  'title',
  'description',
  'student_index',
  'student_name',
  'status',
] as const;

// Each kind of thesis in its own tables, so either can grow fields of its
// own.
export const bachelorTable: ThesisTable = {
  committee: 'bachelor_thesis_staff',
  fields: [...shared, 'submitted', 'file_id', 'mentor', 'member_1', 'member_2'],
  names: [
    ['mentor', 'mentor'],
    ['member', 'member_1'],
    ['member', 'member_2'],
  ],
  table: 'bachelor_theses',
};

export const masterTable: ThesisTable = {
  committee: 'master_thesis_staff',
  fields: [...shared, 'presented', 'file_id', 'mentor', 'president', 'member'],
  names: [
    ['mentor', 'mentor'],
    ['president', 'president'],
    ['member', 'member'],
  ],
  table: 'master_theses',
};

export const thesisTables: readonly ThesisTable[] = [
  bachelorTable,
  masterTable,
];
