// Matching the people of the faculty's pages to staff: by the profile page
// first, then by email, then by name. Pure.

export type Match = {
  readonly rank: MatchRank;
  readonly staff: number;
};

// How a person was matched, in the order the ranks are tried.
export type MatchRank = 'email' | 'name' | 'profile';

// A person as a page of the faculty names them.
export type Person = {
  readonly email: null | string;
  readonly name: string;
  // The address of the staff profile page, as the page links it.
  readonly profile: null | string;
};

// The staff columns the matching reads.
export type StaffRef = {
  readonly email: null | string;
  readonly id: number;
  readonly name: string;
  readonly profile: null | string;
};

const spaces = /\s+/gu;
const scheme = /^[a-z]+:\/\//iu;
const wwwPrefix = /^w{3}\./iu;
const nonName = /[^\p{Letter}\p{Number}\s-]/gu;

// The academic titles and the stops after them: "д-р", "м-р." and
// "проф. д-р" are no part of a name.
const titles =
  /(?<![\p{Letter}-])(?:д-р|м-р|проф|доц|вонр)(?![\p{Letter}-])\.?/giu;

// The text before the first of the characters, or all of it.
const before = (value: string, characters: readonly string[]): string => {
  const ends = characters
    .map((character) => value.indexOf(character))
    .filter((position) => position !== -1);
  return ends.length === 0 ? value : value.slice(0, Math.min(...ends));
};

const withoutTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end--;
  }
  return value.slice(0, end);
};

// The address of a profile page without its scheme, host prefix, query,
// fragment or trailing slash, in lower case: the staff table and the pages
// write the same link in different ways. Null for anything that is no
// address.
export const normalizeProfile = (
  value: null | string | undefined,
): null | string => {
  const bare = withoutTrailingSlashes(
    before((value ?? '').trim().replace(scheme, '').replace(wwwPrefix, ''), [
      '#',
      '?',
    ]),
  );
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // An address with a stray percent sign keeps its text.
  }
  return decoded === '' ? null : decoded.toLowerCase();
};

export const normalizeEmail = (
  value: null | string | undefined,
): null | string => {
  const email = (value ?? '').trim().toLowerCase();
  return email.includes('@') ? email : null;
};

// The key a name matches by: no titles, no punctuation, lower case,
// whitespace collapsed.
export const normalizeName = (value: string): string =>
  value
    .replaceAll(titles, ' ')
    .replaceAll(nonName, ' ')
    .replaceAll(spaces, ' ')
    .trim()
    .toLowerCase();

// Indexes the staff by each key; a key two staff members share names
// neither of them.
const index = (
  staff: readonly StaffRef[],
  keyOf: (member: StaffRef) => null | string,
): Map<string, null | number> => {
  const byKey = new Map<string, null | number>();
  for (const member of staff) {
    const key = keyOf(member);
    if (key !== null && key !== '') {
      byKey.set(key, byKey.has(key) ? null : member.id);
    }
  }
  return byKey;
};

// A matcher over the staff: the staff member of a person, or none. A key
// two staff members share (the same name, or a profile link kept twice)
// matches no one at that rank.
export const matcherOf = (
  staff: readonly StaffRef[],
): ((person: Person) => Match | null) => {
  const byProfile = index(staff, ({ profile }) => normalizeProfile(profile));
  const byEmail = index(staff, ({ email }) => normalizeEmail(email));
  const byName = index(staff, ({ name }) => normalizeName(name));
  return (person) => {
    const profile = normalizeProfile(person.profile);
    const email = normalizeEmail(person.email);
    const name = normalizeName(person.name);
    const candidates: ReadonlyArray<
      readonly [MatchRank, null | number | undefined]
    > = [
      ['profile', profile === null ? undefined : byProfile.get(profile)],
      ['email', email === null ? undefined : byEmail.get(email)],
      ['name', name === '' ? undefined : byName.get(name)],
    ];
    for (const [rank, id] of candidates) {
      if (id !== undefined && id !== null) {
        return { rank, staff: id };
      }
    }
    return null;
  };
};
