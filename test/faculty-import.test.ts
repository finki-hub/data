import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import type {
  SqlBinding,
  SqlClient,
  SqlDatabase,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';

import { openGuardSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import {
  decodeEntities,
  textOf,
  UnrecognizedPageError,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/html.js';
import {
  FacultyImportError,
  httpFacultySource,
  readPages,
  runFacultyImport,
  runLoggedFacultyImport,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/import.js';
import {
  matcherOf,
  normalizeName,
  normalizeProfile,
  type StaffRef,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/match.js';
import {
  parseBio,
  parseCenters,
  parseCouncil,
  parseDeanOffice,
  parseInstitute,
  parseInstituteIndex,
  parseKadarList,
  parseMedia,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/parse.js';
import {
  buildPlan,
  type Pages,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/plan.js';
import {
  clearStructureSql,
  currentTermSql,
  facultyLockSql,
  insertBodyMembersSql,
  insertInstitutesSql,
  staffRefsSql,
  updateProfilesSql,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/sql.js';
import {
  deanPagePath,
  institutesPagePath,
} from '../directus/extensions/directus-extension-data-operations/src/faculty/vocabulary.js';
import { publicReads } from '../src/data-model/access.js';
import { facultyKeys } from '../src/data-model/faculty-collections.js';
import {
  facultyImportCron,
  facultyImportFlow,
  facultyScheduleFlow,
} from '../src/flows/faculty-import.js';
import {
  findCollection,
  findField,
  keyText,
} from './data-model-test-helpers.js';

// The faculty structure import. The fixtures are the main content of the
// real pages of finki.ukim.mk (some cut to their first cards), the WordPress
// REST answers cut to three profiles.

const fixture = (name: string): string =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed folder of this repository
  readFileSync(new URL(`fixtures/faculty/${name}`, import.meta.url), 'utf8');

const dean = fixture('dekanatska-uprava.html');
const council = fixture('nastavno-nauchen-sovet.html');
const institutesIndex = fixture('instituti.html');
const institutePage = fixture('institut-softversko-inzhenerstvo.html');
const centers = fixture('centri.html');
const profile = fixture('profile-ivan-chorbev.html');
const kadarList: unknown = JSON.parse(fixture('kadar-list.json'));
const mediaList: unknown = JSON.parse(fixture('media-list.json'));

const bioStart = /^Роден е 1980 година во Охрид/u;
const markup = /[<>]|&#/u;
const missingDean = /no dean/u;
const offSite = /not a page of the site/u;
const site = 'https://finki.ukim.mk';
const viceDeanTeaching = 'Продекан за настава';
const softwareEngineering = 'Институт за софтверско инженерство';

describe('reading the pages', () => {
  test('decodes the character references an email is written with', () => {
    expect(decodeEntities('&#112;et&#114;e&#064;&#102;inki&#x2E;mk')).toBe(
      'petre@finki.mk',
    );
    expect(decodeEntities('a &amp; b &#8211; c &nbsp;d &unknown;')).toBe(
      'a & b – c  d &unknown;',
    );
    expect(textOf('<p> A <b>b</b>\n c </p>')).toBe('A b c');
  });

  test('reads the dean, the vice deans and the institute heads from the dean office page', () => {
    const office = parseDeanOffice(dean);

    expect(
      office.officers.map(({ person, position }) => [position, person.name]),
    ).toEqual([
      ['Декан', 'д-р Петре Ламески'],
      [viceDeanTeaching, 'д-р Дејан Спасов'],
      ['Продекан за наука и соработка', 'д-р Ристе Стојанов'],
      ['Продекан за финансии', 'д-р Александра Поповска Митровиќ'],
    ]);
    expect(office.officers[0]?.person).toEqual({
      email: 'petre.lameski@finki.ukim.mk',
      name: 'д-р Петре Ламески',
      profile: 'https://finki.ukim.mk/kadar/d-r-petre-lameski/',
    });
    expect(
      office.heads.map(({ institute, person }) => [institute, person.name]),
    ).toEqual([
      [
        'за теориски основи на информатика и пресметковно инженерство',
        'д-р Весна Димитрова',
      ],
      ['за софтверско инженерство', 'д-р Иван Чорбев'],
      ['за информациски системи и мрежни технологии', 'д-р Боро Јакимовски'],
      ['за интелигентни системи', 'д-р Невена Ацковска'],
    ]);
    expect(office.heads[1]?.person.email).toBe('ivan.chorbev@finki.ukim.mk');
  });

  test('keeps the dean office cards in page order with their positions as written', () => {
    expect(
      parseDeanOffice(dean).members.map(({ person, position }) => [
        position,
        person.name,
      ]),
    ).toEqual([
      ['Декан', 'д-р Петре Ламески'],
      [viceDeanTeaching, 'д-р Дејан Спасов'],
      ['Продекан за наука и соработка', 'д-р Ристе Стојанов'],
      ['Продекан за финансии', 'д-р Александра Поповска Митровиќ'],
      [
        'Раководител на институт за теориски основи на информатика и пресметковно инженерство',
        'д-р Весна Димитрова',
      ],
      ['Раководител на институт за софтверско инженерство', 'д-р Иван Чорбев'],
      [
        'Раководител на институт за информациски системи и мрежни технологии',
        'д-р Боро Јакимовски',
      ],
      [
        'Раководител на институт за интелигентни системи',
        'д-р Невена Ацковска',
      ],
    ]);
  });

  test('reads the council members and their profile links', () => {
    const members = parseCouncil(council);

    expect(members.map(({ name }) => name)).toEqual([
      'д-р Марјан Гушев',
      'д-р Катерина Здравкова',
      'д-р Сузана Лошковска',
      'д-р Верица Бакева',
      'д-р Владимир Трајковиќ',
    ]);
    expect(members[0]).toEqual({
      email: null,
      name: 'д-р Марјан Гушев',
      profile: 'https://finki.ukim.mk/kadar/d-r-marjan-gushev/',
    });
  });

  test('lists the institutes and reads the head and members of an institute page', () => {
    const links = parseInstituteIndex(institutesIndex, institutesPagePath);

    expect(links.map(({ name }) => name)).toEqual([
      'Институт за теориски основи на информатика и пресметковно инженерство',
      softwareEngineering,
      'Институт за информациски системи и мрежни технологии',
      'Институт за интелигентни системи',
    ]);
    expect(links[1]?.page).toBe(
      'https://finki.ukim.mk/za-nas/rakovodstvo-i-organizacija/instituti-i-centri/instituti/institut-za-softversko-inzhenerstvo/',
    );

    const page = parseInstitute(institutePage);

    expect(page.head?.name).toBe('д-р Ѓорѓи Маџаров');
    expect(page.head?.email).toBe('gjorgji.madjarov@finki.ukim.mk');
    expect(page.members.map(({ name }) => name)[0]).toBe(
      'м-р. Александар Тенев',
    );
    expect(page.members).toHaveLength(3);
  });

  test('reads each center with the profile link of its head and its own site', () => {
    const list = parseCenters(centers);

    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({
      head: {
        email: null,
        name: '',
        profile: 'https://finki.ukim.mk/kadar/d-r-ana-madevska-bogdanova/',
      },
      name: 'Простор за фокусирање при учење, колегијална поддршка и намалување на академскиот стрес – ФОКУС Лаб',
      page: 'https://finki.ukim.mk/fokus-lab/',
    });
    expect(list[2]).toMatchObject({
      name: 'Центар за информатичко образование и учење на далечина',
      page: null,
    });
  });

  test('reads the biography paragraphs of a profile, and the photos', () => {
    const bio = parseBio(profile) ?? '';
    const paragraphs = bio.split('\n\n');

    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(paragraphs[0]).toMatch(bioStart);
    expect(bio).not.toMatch(markup);
    expect(bio).toContain('Document Management Systems – DMS');
    // Only the résumé tab: not the books table after it.
    expect(bio).not.toContain('Наслов на книгата');
    expect(
      parseBio('<div id="tab-resume" class="x">  </div><div id="tab-b">'),
    ).toBeNull();

    expect(
      parseKadarList(kadarList).map(({ id, media, name }) => [id, media, name]),
    ).toEqual([
      [21_650, 21_657, 'Славе Темков'],
      [21_647, 15_124, 'Димитар Милески'],
      [21_645, 15_124, 'Елизабета Најдовска'],
    ]);
    // FINKI's default image is no photo.
    expect([...parseMedia(mediaList)]).toEqual([
      [
        21_657,
        'https://finki.ukim.mk/wp-content/uploads/2026/09/slave-temkov.jpeg',
      ],
    ]);
  });

  test('fails on a page whose structure it does not know', () => {
    expect(() => parseDeanOffice('<main>moved</main>')).toThrow(
      UnrecognizedPageError,
    );
    expect(() => parseCouncil('<div class="kadar-grid"></div>')).toThrow(
      UnrecognizedPageError,
    );
    expect(() => parseInstituteIndex('<p></p>', institutesPagePath)).toThrow(
      UnrecognizedPageError,
    );
    expect(() => parseInstitute('<div class="institut"></div>')).toThrow(
      UnrecognizedPageError,
    );
    expect(() =>
      parseCenters('<div class="page-content__body"></div></article>'),
    ).toThrow(UnrecognizedPageError);
    expect(() => parseCenters('<p>no body</p>')).toThrow(UnrecognizedPageError);
    expect(() => parseBio('<p>no tabs</p>')).toThrow(UnrecognizedPageError);
    expect(() => parseKadarList({ code: 'rest_error' })).toThrow(
      UnrecognizedPageError,
    );
    expect(() => parseMedia([{ id: 'x' }])).toThrow(UnrecognizedPageError);
    // A dean office page without its dean is not the page it was.
    expect(() => parseDeanOffice(dean.replace('>Декан<', '>Нешто<'))).toThrow(
      missingDean,
    );
  });
});

describe('matching people to staff', () => {
  const people: StaffRef[] = [
    {
      email: 'someone@finki.ukim.mk',
      id: 1,
      name: 'Петре Ламески',
      profile: 'https://www.finki.ukim.mk/kadar/d-r-petre-lameski',
    },
    {
      email: 'Dejan.Spasov@finki.ukim.mk',
      id: 2,
      name: 'Другое Име',
      profile: null,
    },
    { email: null, id: 3, name: 'Ристе  Стојанов', profile: null },
    { email: null, id: 4, name: 'Иста Личност', profile: null },
    { email: null, id: 5, name: 'иста личност', profile: null },
  ];
  const match = matcherOf(people);

  test('normalizes profile links, titles and names', () => {
    expect(normalizeProfile('https://www.finki.ukim.mk/kadar/X/?a=1#b')).toBe(
      'finki.ukim.mk/kadar/x',
    );
    expect(normalizeProfile('  ')).toBeNull();
    expect(normalizeProfile(null)).toBeNull();
    expect(normalizeProfile('https://finki.ukim.mk/kadar/%D0%B0/')).toBe(
      'finki.ukim.mk/kadar/а',
    );
    expect(normalizeProfile('https://finki.ukim.mk/kadar/%E0%A4%A/')).toBe(
      'finki.ukim.mk/kadar/%e0%a4%a',
    );
    expect(normalizeName('д-р  Петре Ламески')).toBe('петре ламески');
    expect(normalizeName('м-р. Александар Тенев')).toBe('александар тенев');
    expect(normalizeName('проф. д-р Иван Чорбев')).toBe('иван чорбев');
  });

  test('matches by profile page first, then email, then name', () => {
    expect(
      match({
        email: 'dejan.spasov@finki.ukim.mk',
        name: 'Ристе Стојанов',
        profile: 'https://finki.ukim.mk/kadar/d-r-petre-lameski/',
      }),
    ).toEqual({ rank: 'profile', staff: 1 });
    expect(
      match({
        email: 'dejan.spasov@finki.ukim.mk',
        name: 'д-р Ристе Стојанов',
        profile: 'https://finki.ukim.mk/kadar/other/',
      }),
    ).toEqual({ rank: 'email', staff: 2 });
    expect(
      match({ email: null, name: 'д-р Ристе Стојанов', profile: null }),
    ).toEqual({ rank: 'name', staff: 3 });
  });

  test('matches no one by a name two staff members share, or by nothing', () => {
    expect(
      match({ email: null, name: 'Иста Личност', profile: null }),
    ).toBeNull();
    expect(match({ email: null, name: '', profile: null })).toBeNull();
    expect(match({ email: null, name: 'Непознат', profile: null })).toBeNull();
  });
});

// The staff of the plan: matched by profile, email and name in turn.
const staff: StaffRef[] = [
  {
    email: 'x@finki.ukim.mk',
    id: 1,
    name: 'Петре Ламески',
    profile: 'https://finki.ukim.mk/kadar/d-r-petre-lameski',
  },
  {
    email: 'dejan.spasov@finki.ukim.mk',
    id: 2,
    name: 'Дејан С.',
    profile: null,
  },
  { email: null, id: 3, name: 'Ристе Стојанов', profile: null },
  {
    email: null,
    id: 4,
    name: 'Ѓорѓи Маџаров',
    profile: 'https://finki.ukim.mk/kadar/d-r-gjorgji-madzharov/',
  },
  {
    email: null,
    id: 5,
    name: 'Иван Чорбев',
    profile: 'https://finki.ukim.mk/kadar/d-r-ivan-chorbev/',
  },
  { email: null, id: 6, name: 'Славе Темков', profile: null },
];

const pagesOf = (): Pages => {
  const links = parseInstituteIndex(institutesIndex, institutesPagePath);
  const page = parseInstitute(institutePage);
  return {
    bios: new Map([
      [21_647, null],
      [21_650, 'Биографија'],
    ]),
    centers: parseCenters(centers),
    council: parseCouncil(council),
    dean: parseDeanOffice(dean),
    institutes: links.map((link) => ({ link, page })),
    kadar: parseKadarList(kadarList),
    photos: parseMedia(mediaList),
  };
};

describe('the faculty structure plan', () => {
  const plan = buildPlan(pagesOf(), staff, [
    { name: 'Петре Ламески', position: 'Декан', staff: 1, year: 2_026 },
    {
      name: 'Ристе Стојанов',
      position: viceDeanTeaching,
      staff: 3,
      year: 2_026,
    },
  ]);

  test('takes the head of an institute from the dean office page, not from its own page', () => {
    const institute = plan.institutes.find(
      ({ name }) => name === softwareEngineering,
    );

    // The institute page names Маџаров (4); the dean office page Чорбев (5).
    expect(institute?.head).toBe(5);
    expect(
      plan.members
        .filter(({ institute: name }) => name === softwareEngineering)
        .map(({ staff: id }) => id),
    ).toEqual([5, 4]);
    // The heads of the other institutes are not on staff: no head, and
    // each is recorded.
    expect(
      plan.institutes
        .filter(({ head }) => head === null)
        .map(({ name }) => name),
    ).toHaveLength(3);
  });

  test('matches the council and the centers, and records the people left over', () => {
    // Of both bodies only the dean office page's people are on staff here,
    // in page order with the position as the page writes it.
    expect(plan.bodyMembers).toEqual([
      { body: 'management_board', position: 'Декан', sort: 1, staff: 1 },
      {
        body: 'management_board',
        position: viceDeanTeaching,
        sort: 2,
        staff: 2,
      },
      {
        body: 'management_board',
        position: 'Продекан за наука и соработка',
        sort: 3,
        staff: 3,
      },
      {
        body: 'management_board',
        position: 'Раководител на институт за софтверско инженерство',
        sort: 6,
        staff: 5,
      },
    ]);
    expect(plan.centers.map(({ head }) => head)).toEqual(
      plan.centers.map(({ head }) => (head === 5 ? 5 : null)),
    );
    expect(plan.centers.find(({ head }) => head === 5)?.name).toBe(
      'Центар за одржување и развој на универзитетски сервиси',
    );

    const unmatched = plan.issues.filter(
      ({ kind }) => kind === 'unmatched_person',
    );

    // Every council member is on staff in no row here, and a center head
    // is named by the profile link when the page gives no name.
    expect(
      unmatched
        .filter(({ body }) => body === 'Teaching and research council')
        .map(({ name }) => name),
    ).toEqual([
      'д-р Марјан Гушев',
      'д-р Катерина Здравкова',
      'д-р Сузана Лошковска',
      'д-р Верица Бакева',
      'д-р Владимир Трајковиќ',
    ]);
    expect(
      unmatched.find(
        ({ detail }) => detail === 'Head of Центар за социјални иновации',
      ),
    ).toMatchObject({
      body: 'Centers',
      name: 'd-r-dimitar-trajanov',
      profile: 'https://finki.ukim.mk/kadar/d-r-dimitar-trajanov/',
    });

    // A person on a page twice in one place is recorded once.
    const keys = unmatched.map(
      ({ body, detail, name }) => `${body}|${detail ?? ''}|${name}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  test('flags a dean office term that differs from the page, and writes nothing to it', () => {
    const flagged = plan.issues.filter(({ kind }) => kind === 'deans_office');

    expect(flagged.map(({ name }) => name)).toEqual([
      viceDeanTeaching,
      'Продекан за наука и соработка',
    ]);
    expect(flagged[0]?.detail).toBe(
      "The page names д-р Дејан Спасов; the dean's office has Ристе Стојанов in 2026.",
    );
    expect(flagged[1]?.detail).toContain('has no holder');
    // The dean matches the term: nothing flagged.
    expect(flagged.map(({ name }) => name)).not.toContain('Декан');
  });

  test('flags a head of an institute the list does not have', () => {
    const only = {
      ...pagesOf(),
      institutes: pagesOf().institutes.slice(1, 2),
    };
    const flagged = buildPlan(only, staff, []).issues.filter(
      ({ detail, kind }) =>
        kind === 'deans_office' &&
        detail?.includes('no listed institute') === true,
    );

    expect(flagged).toHaveLength(3);
  });

  test('sets the photo and biography of the profiles that stand for a staff member', () => {
    // Славе Темков matches by name; Димитар Милески has no staff row.
    expect(plan.profiles).toEqual([
      {
        bio: 'Биографија',
        id: 6,
        photo:
          'https://finki.ukim.mk/wp-content/uploads/2026/09/slave-temkov.jpeg',
      },
    ]);

    const defaulted = buildPlan(
      pagesOf(),
      [
        ...staff,
        { email: null, id: 7, name: 'Димитар Милески', profile: null },
      ],
      [],
    ).profiles.find(({ id }) => id === 7);

    expect(defaulted).toEqual({ bio: null, id: 7, photo: null });
  });

  test('lets a profile link matched on one page match the staff member for the profile list', () => {
    const entry = {
      id: 1,
      link: 'https://finki.ukim.mk/kadar/d-r-ivan-chorbev/',
      media: null,
      name: 'Нешто Сосема Различно',
    };
    const learned = buildPlan({ ...pagesOf(), kadar: [entry] }, staff, []);

    expect(learned.profiles).toEqual([{ bio: null, id: 5, photo: null }]);
  });
});

type Statement = { readonly bindings: SqlBinding[]; readonly sql: string };

const fakeDatabase = () => {
  const transactions: Statement[][] = [];
  const client = (log: Statement[]): SqlClient => ({
    raw: (sql, bindings = []) => {
      log.push({ bindings, sql });
      if (sql === staffRefsSql) {
        return Promise.resolve({ rows: staff });
      }
      if (sql === currentTermSql) {
        return Promise.resolve({
          rows: [
            {
              name: 'Петре Ламески',
              position: 'Декан',
              staff: '1',
              year: '2026',
            },
          ],
        });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
  });
  const database: SqlDatabase = {
    ...client([]),
    transaction: async (work) => {
      const log: Statement[] = [];
      transactions.push(log);
      return work(client(log));
    },
  };
  return { database, transactions };
};

// The site over the fixtures: every institute page and profile is the one
// fixture, the lists are the REST excerpts.
const answers = (overrides: Record<string, string> = {}) => {
  const requested: string[] = [];
  const pages: Record<string, string> = {
    [`${site}${deanPagePath}`]: dean,
    [`${site}/za-nas/rakovodstvo-i-organizacija/nastavno-nauchen-sovet/`]:
      council,
    [`${site}${institutesPagePath}`]: institutesIndex,
    [`${site}/za-nas/rakovodstvo-i-organizacija/instituti-i-centri/centri/`]:
      centers,
    ...overrides,
  };
  const text = (url: string): Promise<string> => {
    requested.push(url);
    return Promise.resolve(
      pages[url] ??
        (url.includes(institutesPagePath) ? institutePage : profile),
    );
  };
  const json = (url: string): Promise<unknown> => {
    requested.push(url);
    return Promise.resolve(url.includes('/media?') ? mediaList : kadarList);
  };
  return {
    feed: {
      pause: () => {
        requested.push('pause');
        return Promise.resolve();
      },
      site,
      source: { json, text },
    },
    requested,
  };
};

const listed = (id: number) => ({
  featured_media: 0,
  id,
  link: `${site}/kadar/p${String(id)}/`,
  title: { rendered: `P ${String(id)}` },
});

const answerWith =
  (status: number, body: string): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

// The error a read of the source ends with.
const failure = async (
  fetcher: typeof fetch,
  read: 'json' | 'text',
): Promise<unknown> => {
  try {
    await httpFacultySource(fetcher)[read]('https://x.test/');
  } catch (error) {
    return error;
  }
  return null;
};

describe('the faculty structure import', () => {
  test('reads every page before it opens the transaction and replaces the structure in it', async () => {
    const { database, transactions } = fakeDatabase();
    const { feed, requested } = answers();

    const summary = await runFacultyImport(database, feed);

    expect(summary).toMatchObject({
      bios: 1,
      centers: 10,
      council: 0,
      institutes: 4,
      photos: 1,
    });
    expect(summary.unmatched.length).toBeGreaterThan(0);
    expect(summary.issues).toBeGreaterThanOrEqual(summary.unmatched.length);
    // One transaction: lock, guard, the staff and the term read, the four
    // tables cleared, then the fills and the staff updates.
    expect(transactions).toHaveLength(1);

    const [log = []] = transactions;
    const sql = log.map((statement) => statement.sql);

    expect(sql.slice(0, 4)).toEqual([
      facultyLockSql,
      openGuardSql('institutes'),
      staffRefsSql,
      currentTermSql,
    ]);
    expect(sql.slice(4, 4 + clearStructureSql.length)).toEqual(
      clearStructureSql,
    );
    expect(sql.at(-2)).toBe(updateProfilesSql);
    expect(sql.at(-1)).toBe(insertBodyMembersSql);

    const institutes = log.find(
      ({ sql: text }) => text === insertInstitutesSql,
    );

    expect(JSON.parse(String(institutes?.bindings[0]))).toContainEqual({
      head: 5,
      name: softwareEngineering,
      page: 'https://finki.ukim.mk/za-nas/rakovodstvo-i-organizacija/instituti-i-centri/instituti/institut-za-softversko-inzhenerstvo/',
    });
    // The 4 institute pages, 3 profiles; a pause before each request but
    // the first.
    expect(requested.filter((url) => url === 'pause')).toHaveLength(
      requested.length - 1 - requested.filter((url) => url === 'pause').length,
    );
    expect(requested.filter((url) => url.includes('/kadar/'))).toHaveLength(3);
  });

  test('keeps the previous data when a page changed shape: nothing is written', async () => {
    const { database, transactions } = fakeDatabase();
    const { feed } = answers({
      [`${site}/za-nas/rakovodstvo-i-organizacija/nastavno-nauchen-sovet/`]:
        '<main>redesigned</main>',
    });

    await expect(runFacultyImport(database, feed)).rejects.toMatchObject({
      code: 'FACULTY_PAGE_INVALID',
      name: 'FacultyImportError',
    });
    expect(transactions).toEqual([]);
  });

  test('logs why a run failed, with the cause, and still fails it', async () => {
    const { database, transactions } = fakeDatabase();
    const { feed } = answers();
    const reset = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    const fetcher = (() =>
      Promise.reject(
        new TypeError('fetch failed', { cause: reset }),
      )) as typeof fetch;
    const logged: string[] = [];

    await expect(
      runLoggedFacultyImport(
        database,
        { ...feed, source: httpFacultySource(fetcher) },
        {
          error: (message) => {
            logged.push(message);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'FACULTY_SITE_FAILED' });
    expect(logged).toEqual([
      `Faculty structure import failed: ${site}${deanPagePath}: unreachable or too slow [FACULTY_SITE_FAILED]: fetch failed: read ECONNRESET [ECONNRESET]`,
    ]);
    expect(transactions).toEqual([]);
  });

  test('logs nothing for a run that succeeds', async () => {
    const { database } = fakeDatabase();
    const { feed } = answers();
    const logged: string[] = [];

    await runLoggedFacultyImport(database, feed, {
      error: (message) => {
        logged.push(message);
      },
    });

    expect(logged).toEqual([]);
  });

  test('fetches no page off the site', async () => {
    const { feed } = answers({
      [`${site}${institutesPagePath}`]: institutesIndex.replaceAll(
        'https://finki.ukim.mk/za-nas',
        'https://elsewhere.test/za-nas',
      ),
    });

    await expect(readPages(feed)).rejects.toThrow(offSite);
  });

  test('reads a profile list over several pages until a short one', async () => {
    const full = Array.from({ length: 100 }, (_, index) => listed(index + 1));
    const requested: string[] = [];
    const { feed } = answers();
    const pages = await readPages({
      ...feed,
      source: {
        json: (url) => {
          requested.push(url);
          if (url.includes('/media?')) {
            return Promise.resolve([]);
          }
          return Promise.resolve(
            url.includes('page=1&') ? full : [listed(101)],
          );
        },
        text: feed.source.text,
      },
    });

    expect(pages.kadar).toHaveLength(101);
    expect(
      requested.filter((url) => url.includes('nastaven_kadar')),
    ).toHaveLength(2);
    expect(pages.bios.size).toBe(101);
  });
});

describe('the HTTP source', () => {
  test('reads text and JSON, and sends a descriptive User-Agent with a timeout', async () => {
    const seen: Array<Parameters<typeof fetch>[1]> = [];
    const fetcher = ((_url: string, init: Parameters<typeof fetch>[1]) => {
      seen.push(init);
      return Promise.resolve(new Response('[1]'));
    }) as typeof fetch;
    const source = httpFacultySource(fetcher);

    await expect(source.json('https://x.test/a')).resolves.toEqual([1]);
    await expect(source.text('https://x.test/b')).resolves.toBe('[1]');
    expect(seen[0]?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('finki-hub') as string,
    });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('treats a list page past the end as an empty list', async () => {
    await expect(
      httpFacultySource(
        answerWith(400, '{"code":"rest_post_invalid_page_number"}'),
      ).json('https://x.test/'),
    ).resolves.toEqual([]);
  });

  test('answers FACULTY_SITE_FAILED for an error status, bad JSON or no answer', async () => {
    const unreachable = (() =>
      Promise.reject(new Error('down'))) as typeof fetch;

    const errors = await Promise.all([
      failure(answerWith(500, ''), 'json'),
      failure(answerWith(404, ''), 'text'),
      failure(answerWith(400, 'other'), 'json'),
      failure(answerWith(200, '<html>'), 'json'),
      failure(unreachable, 'text'),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(FacultyImportError);
      expect(error).toMatchObject({ code: 'FACULTY_SITE_FAILED' });
    }
  });
});

describe('the faculty structure model', () => {
  test('keeps one member per institute and index by staff', () => {
    expect(facultyKeys.map(keyText)).toEqual([
      'unique institute_members (institute, staff)',
      'index institute_members (staff)',
      'unique faculty_body_members (body, staff)',
    ]);
  });

  test('writes the staff columns only by the import: Studio shows them read-only', () => {
    for (const field of ['photo', 'bio']) {
      expect(findField('staff', field)).toMatchObject({ readOnly: true });
    }

    for (const collection of [
      'institutes',
      'institute_members',
      'faculty_centers',
      'faculty_body_members',
      'faculty_import_issues',
    ]) {
      expect(
        findCollection(collection).fields.every(
          (field) => field.readOnly === true,
        ),
      ).toBeTruthy();
    }
  });

  test('publishes the structure but not the import issues', () => {
    const published = publicReads.map(({ collection }) => collection);

    expect(published).toEqual(
      expect.arrayContaining([
        'institutes',
        'institute_members',
        'faculty_centers',
      ]),
    );
    expect(published).not.toContain('faculty_import_issues');
  });

  test('runs daily at 05:30 as a button and a schedule', () => {
    expect(facultyImportFlow.trigger).toBe('manual');
    expect(facultyScheduleFlow.options).toEqual({ cron: facultyImportCron });
    expect(facultyImportCron).toBe('0 30 5 * * *');
    expect(facultyImportFlow.name).toBe('Data / Import faculty structure');
    expect(facultyScheduleFlow.name).toBe(
      'Data / Import faculty structure daily',
    );
  });
});
