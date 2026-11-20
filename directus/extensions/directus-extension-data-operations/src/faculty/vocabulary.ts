// The vocabularies of the faculty structure import, declared once: the data
// model (src/data-model/faculty-collections.ts) and the import read them
// from here. Pure: it imports nothing.

// Where the faculty publishes its structure and staff profiles.
export const defaultFacultySite = 'https://finki.ukim.mk';

// The bodies of the structure page, each a page under this path of the
// site.
export const structurePath = '/za-nas/rakovodstvo-i-organizacija/';
export const deanPagePath = `${structurePath}dekanatska-uprava/`;
export const councilPagePath = `${structurePath}nastavno-nauchen-sovet/`;
export const institutesPagePath = `${structurePath}instituti-i-centri/instituti/`;
export const centersPagePath = `${structurePath}instituti-i-centri/centri/`;

// The kinds of attention the import records for the dashboard.
export const issueKinds = ['deans_office', 'unmatched_person'] as const;

export type IssueKind = (typeof issueKinds)[number];

// The names the import gives the bodies it reads, as the dashboard lists
// them.
export const bodyNames = {
  centers: 'Centers',
  council: 'Teaching and research council',
  dean: "Dean's office",
  institutes: 'Institutes',
} as const;

export type BodyName = (typeof bodyNames)[keyof typeof bodyNames];

// FINKI's placeholder for a profile without a photo; never stored.
export const defaultPhotoName = 'finki-default-featured-image';
