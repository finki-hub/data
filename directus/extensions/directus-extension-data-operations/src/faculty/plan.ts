import type {
  Center,
  DeanOffice,
  InstituteLink,
  InstitutePage,
  KadarEntry,
} from './parse.js';

import {
  matcherOf,
  normalizeName,
  normalizeProfile,
  type Person,
  type StaffRef,
} from './match.js';
import { type BodyName, bodyNames, type IssueKind } from './vocabulary.js';

// What the import derives from the pages it read and from the staff and
// dean's office it matches them to. Pure: the parsed pages in, the rows
// out.

export type IssueRow = {
  readonly body: BodyName;
  readonly detail: null | string;
  readonly email: null | string;
  readonly kind: IssueKind;
  readonly name: string;
  readonly profile: null | string;
};

export type Pages = {
  // The biography of each profile, by the id of its list entry.
  readonly bios: ReadonlyMap<number, null | string>;
  readonly centers: readonly Center[];
  readonly council: readonly Person[];
  readonly dean: DeanOffice;
  readonly institutes: ReadonlyArray<{
    readonly link: InstituteLink;
    readonly page: InstitutePage;
  }>;
  readonly kadar: readonly KadarEntry[];
  // The photo address of each media id.
  readonly photos: ReadonlyMap<number, string>;
};

export type Plan = {
  readonly centers: ReadonlyArray<{
    readonly head: null | number;
    readonly name: string;
    readonly page: null | string;
  }>;
  readonly councilIds: readonly number[];
  readonly institutes: ReadonlyArray<{
    readonly head: null | number;
    readonly name: string;
    readonly page: string;
  }>;
  readonly issues: readonly IssueRow[];
  readonly members: ReadonlyArray<{
    readonly institute: string;
    readonly staff: number;
  }>;
  readonly profiles: ReadonlyArray<{
    readonly bio: null | string;
    readonly id: number;
    readonly photo: null | string;
  }>;
};

// The holder of a position in the latest term of the dean's office.
export type TermHolder = {
  readonly name: string;
  readonly position: string;
  readonly staff: number;
  readonly year: number;
};

const spaces = /\s+/gu;

const collapse = (value: string): string =>
  value.replaceAll(spaces, ' ').trim().toLowerCase();

// The last segment of a profile address, for a person a page names only
// by a link.
const slugOf = (profile: null | string): null | string =>
  profile?.split('/').findLast((segment) => segment !== '') ?? null;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const present = (id: null | number): id is number => id !== null;

// Resolving the people of the pages to staff, and recording the ones left
// over.
const resolverOf = (
  staff: readonly StaffRef[],
  kadar: readonly KadarEntry[],
) => {
  const match = matcherOf(staff);
  const issues: IssueRow[] = [];
  const names = new Map(
    kadar.flatMap(({ link, name }) => {
      const key = normalizeProfile(link);
      return key === null ? [] : [[key, name] as const];
    }),
  );
  // The profile links of matched people: another page naming the same link
  // inherits the match, however the first one was matched.
  const learned = new Map<string, number>();
  const resolved = new Map<Person, null | number>();
  const seen = new Set<string>();

  const resolve = (person: Person): null | number => {
    const known = resolved.get(person);
    if (known !== undefined) {
      return known;
    }
    const found = match(person)?.staff ?? null;
    resolved.set(person, found);
    const link = normalizeProfile(person.profile);
    if (found !== null && link !== null && !learned.has(link)) {
      learned.set(link, found);
    }
    return found;
  };

  const displayName = (person: Person): string =>
    person.name === ''
      ? (names.get(normalizeProfile(person.profile) ?? '') ??
        slugOf(person.profile) ??
        person.email ??
        '')
      : person.name;

  // Records a person no staff member stands for, once per body and place.
  const unmatched = (
    body: BodyName,
    person: Person,
    detail: null | string,
  ): void => {
    const who =
      normalizeProfile(person.profile) ??
      person.email ??
      normalizeName(person.name);
    const key = [body, detail ?? '', who].join('|');
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    issues.push({
      body,
      detail,
      email: person.email,
      kind: 'unmatched_person',
      name: displayName(person),
      profile: person.profile,
    });
  };

  const staffOf = (
    body: BodyName,
    person: Person,
    detail: null | string = null,
  ): null | number => {
    const id = resolve(person);
    if (id === null) {
      unmatched(body, person, detail);
    }
    return id;
  };

  return { displayName, issues, learned, match, resolve, staffOf };
};

type Resolver = ReturnType<typeof resolverOf>;

// The heads, as the dean's office page names them: it is authoritative,
// the institutes' own pages can disagree. A head of an institute the list
// does not have is flagged.
const headsOf = (
  { dean, institutes }: Pages,
  { issues, staffOf }: Resolver,
): Map<string, null | number> => {
  const headOf = new Map<string, null | number>();
  for (const { institute, person } of dean.heads) {
    const id = staffOf(bodyNames.dean, person, `Head of ${institute}`);
    const key = collapse(`институт ${institute}`);
    if (institutes.some(({ link }) => collapse(link.name) === key)) {
      headOf.set(key, id);
    } else {
      issues.push({
        body: bodyNames.dean,
        detail: `The page names a head of "${institute}", which is no listed institute.`,
        email: null,
        kind: 'deans_office',
        name: `Head of institute ${institute}`,
        profile: null,
      });
    }
  }
  return headOf;
};

// The dean and vice deans of the page against the latest term of the
// dean's office, which stays hand-kept: a difference is only flagged.
const flagTerm = (
  { dean }: Pages,
  term: readonly TermHolder[],
  { displayName, issues, staffOf }: Resolver,
): void => {
  for (const { person, position } of dean.officers) {
    const onPage = staffOf(bodyNames.dean, person, position);
    const holder = term.find((entry) => entry.position === position);
    if (onPage === null || holder?.staff === onPage) {
      continue;
    }
    issues.push({
      body: bodyNames.dean,
      detail:
        holder === undefined
          ? `The page names ${displayName(person)}; the dean's office has no holder of it in its latest term.`
          : `The page names ${displayName(person)}; the dean's office has ${holder.name} in ${String(holder.year)}.`,
      email: null,
      kind: 'deans_office',
      name: position,
      profile: person.profile,
    });
  }
};

// The photo and biography of every profile that stands for a staff
// member; the first profile of a member wins.
const profilesOf = (
  { bios, kadar, photos }: Pages,
  { learned, match }: Resolver,
): Plan['profiles'] => {
  const profiles = new Map<number, Plan['profiles'][number]>();
  for (const entry of kadar) {
    const link = normalizeProfile(entry.link);
    const id =
      (link === null ? undefined : learned.get(link)) ??
      match({ email: null, name: entry.name, profile: entry.link })?.staff;
    if (id !== undefined && !profiles.has(id)) {
      profiles.set(id, {
        bio: bios.get(entry.id) ?? null,
        id,
        photo: entry.media === null ? null : (photos.get(entry.media) ?? null),
      });
    }
  }
  return profiles.values().toArray();
};

export const buildPlan = (
  pages: Pages,
  staff: readonly StaffRef[],
  term: readonly TermHolder[],
): Plan => {
  const resolver = resolverOf(staff, pages.kadar);
  const { issues, staffOf } = resolver;
  const headOf = headsOf(pages, resolver);

  const institutes = pages.institutes.map(({ link }) => ({
    head: headOf.get(collapse(link.name)) ?? null,
    name: link.name,
    page: link.page,
  }));

  // The members of an institute: its own page lists them, the head of the
  // dean's office page is one of them.
  const members = pages.institutes.flatMap(({ link, page }) => {
    const head = headOf.get(collapse(link.name)) ?? null;
    const people =
      page.head === null ? page.members : [page.head, ...page.members];
    const ids = people.map((person) =>
      staffOf(bodyNames.institutes, person, `Member of ${link.name}`),
    );
    return unique([head, ...ids].filter(present)).map((id) => ({
      institute: link.name,
      staff: id,
    }));
  });

  const centers = pages.centers.map((center) => ({
    head:
      center.head === null
        ? null
        : staffOf(bodyNames.centers, center.head, `Head of ${center.name}`),
    name: center.name,
    page: center.page,
  }));

  const councilIds = unique(
    pages.council
      .map((person) => staffOf(bodyNames.council, person))
      .filter(present),
  );

  flagTerm(pages, term, resolver);

  return {
    centers,
    councilIds,
    institutes,
    issues,
    members,
    profiles: profilesOf(pages, resolver),
  };
};
