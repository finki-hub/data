// The vocabularies of the thesis import, declared once: the data model
// (src/data-model/thesis-collections.ts) and the import read them from
// here. Pure: it imports nothing.

export const thesisLevels = ['bachelor', 'master'] as const;

export type ThesisLevel = (typeof thesisLevels)[number];

// What a staff member was on a thesis: its mentor, the president of a
// master's committee or one of the other members.
export const committeeRoles = ['mentor', 'president', 'member'] as const;

export type CommitteeRole = (typeof committeeRoles)[number];
