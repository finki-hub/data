import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import type { SqlClient, SqlDatabase } from '../coordination/sql-port.js';
import type { StaffRef } from './match.js';

import { json, openGuard, run } from '../coordination/sql-run.js';
import { UnrecognizedPageError } from './html.js';
import {
  parseBio,
  parseCenters,
  parseCouncil,
  parseDeanOffice,
  parseInstitute,
  parseInstituteIndex,
  parseKadarList,
  parseMedia,
} from './parse.js';
import { buildPlan, type Pages, type Plan, type TermHolder } from './plan.js';
import {
  clearStructureSql,
  currentTermSql,
  facultyLockSql,
  insertCentersSql,
  insertInstitutesSql,
  insertIssuesSql,
  insertMembersSql,
  staffRefsSql,
  updateCouncilSql,
  updateProfilesSql,
} from './sql.js';
import {
  centersPagePath,
  councilPagePath,
  deanPagePath,
  defaultFacultySite,
  institutesPagePath,
} from './vocabulary.js';

// The faculty structure import: reads the dean's office, council,
// institutes and centers pages of finki.ukim.mk and the staff profiles,
// matches the people to staff and replaces the structure tables with the
// result, all in one transaction after every page was read. A page whose
// structure the parsers do not recognise fails the run, which keeps the
// previous data.

// How many items the WordPress REST API lists per page (its maximum), and
// so how many media ids one request names.
const listPageSize = 100;

// The pause between two page requests, so a run of some two hundred pages
// stays polite to the faculty's site.
export const defaultPauseMs = 200;

// Where the import reads the pages: the site over a source, pausing
// between requests.
export type FacultyFeed = {
  readonly pause: () => Promise<void>;
  readonly site: string;
  readonly source: FacultySource;
};

export type FacultyImportSummary = {
  readonly bios: number;
  readonly centers: number;
  readonly council: number;
  readonly institutes: number;
  readonly issues: number;
  readonly members: number;
  readonly photos: number;
  readonly unmatched: ReadonlyArray<{
    readonly body: string;
    readonly name: string;
  }>;
};

// GET of a URL, as text or as JSON.
export type FacultySource = {
  readonly json: (url: string) => Promise<unknown>;
  readonly text: (url: string) => Promise<string>;
};

const staffRows = z.array(
  z.object({
    email: z.string().nullable(),
    id: z.coerce.number().int(),
    name: z.string(),
    profile: z.string().nullable(),
  }),
);

const termRows = z.array(
  z.object({
    name: z.string(),
    position: z.string(),
    staff: z.coerce.number().int(),
    year: z.coerce.number().int(),
  }),
);

// A refusal of the import, with a code the Flow answers.
export class FacultyImportError extends Error {
  public readonly code: string;
  public override readonly name = 'FacultyImportError';

  public constructor(
    message: string,
    options: ErrorOptions & { readonly code: string },
  ) {
    super(message, options);
    this.code = options.code;
  }
}

const root = (base: string): string =>
  base.endsWith('/') ? base.slice(0, -1) : base;

// The feed with a pause before every request but the first.
const spaced = (feed: FacultyFeed): FacultySource => {
  const requests = { made: 0 };
  const wait = async (): Promise<void> => {
    const earlier = requests.made;
    requests.made += 1;
    if (earlier > 0) {
      await feed.pause();
    }
  };
  return {
    json: async (url) => {
      await wait();
      return feed.source.json(url);
    },
    text: async (url) => {
      await wait();
      return feed.source.text(url);
    },
  };
};

// Reads every page the import needs. Only addresses on the site are
// fetched: a link of a page that leads elsewhere is a page the parsers do
// not know.
export const readPages = async (feed: FacultyFeed): Promise<Pages> => {
  const site = root(feed.site);
  const source = spaced(feed);
  const onSite = (url: string): string => {
    if (!url.startsWith(`${site}/`)) {
      throw new UnrecognizedPageError(`${url}: not a page of the site`);
    }
    return url;
  };
  const dean = parseDeanOffice(await source.text(`${site}${deanPagePath}`));
  const council = parseCouncil(await source.text(`${site}${councilPagePath}`));
  const links = parseInstituteIndex(
    await source.text(`${site}${institutesPagePath}`),
    institutesPagePath,
  );
  const institutes: Array<Pages['institutes'][number]> = [];
  for (const link of links) {
    institutes.push({
      link,
      page: parseInstitute(await source.text(onSite(link.page))),
    });
  }
  const centers = parseCenters(await source.text(`${site}${centersPagePath}`));

  const kadar: ReturnType<typeof parseKadarList> = [];
  for (let page = 1; ; page++) {
    const listed = parseKadarList(
      await source.json(
        `${site}/wp-json/wp/v2/nastaven_kadar?per_page=${String(listPageSize)}&page=${String(page)}&_fields=id,link,featured_media,title`,
      ),
    );
    kadar.push(...listed);
    if (listed.length < listPageSize) {
      break;
    }
  }
  if (kadar.length === 0) {
    throw new UnrecognizedPageError('profile list: no profiles');
  }

  const media = [
    ...new Set(kadar.flatMap(({ media: id }) => (id === null ? [] : [id]))),
  ];
  const photos = new Map<number, string>();
  for (let from = 0; from < media.length; from += listPageSize) {
    const ids = media.slice(from, from + listPageSize).join(',');
    const listed = parseMedia(
      await source.json(
        `${site}/wp-json/wp/v2/media?per_page=${String(listPageSize)}&include=${ids}&_fields=id,source_url`,
      ),
    );
    for (const [id, url] of listed) {
      photos.set(id, url);
    }
  }

  const bios = new Map<number, null | string>();
  for (const entry of kadar) {
    bios.set(entry.id, parseBio(await source.text(onSite(entry.link))));
  }
  return { bios, centers, council, dean, institutes, kadar, photos };
};

const writePlan = async (client: SqlClient, plan: Plan): Promise<void> => {
  for (const statement of clearStructureSql) {
    await run(client, statement);
  }
  await run(client, insertInstitutesSql, [json(plan.institutes)]);
  await run(client, insertMembersSql, [json(plan.members)]);
  await run(client, insertCentersSql, [json(plan.centers)]);
  await run(client, insertIssuesSql, [json(plan.issues)]);
  await run(client, updateProfilesSql, [json(plan.profiles)]);
  await run(client, updateCouncilSql, [json(plan.councilIds)]);
};

export const runFacultyImport = async (
  database: SqlDatabase,
  feed: FacultyFeed,
): Promise<FacultyImportSummary> => {
  let pages: Pages;
  try {
    pages = await readPages(feed);
  } catch (error) {
    if (error instanceof UnrecognizedPageError) {
      throw new FacultyImportError(error.message, {
        cause: error,
        code: 'FACULTY_PAGE_INVALID',
      });
    }
    throw error;
  }
  return database.transaction(async (client) => {
    await run(client, facultyLockSql);
    await openGuard(client, 'institutes');
    const staffRead = await run(client, staffRefsSql);
    const termRead = await run(client, currentTermSql);
    const staff: StaffRef[] = staffRows.parse(staffRead.rows);
    const term: TermHolder[] = termRows.parse(termRead.rows);
    const plan = buildPlan(pages, staff, term);
    await writePlan(client, plan);
    return {
      bios: plan.profiles.filter(({ bio }) => bio !== null).length,
      centers: plan.centers.length,
      council: plan.councilIds.length,
      institutes: plan.institutes.length,
      issues: plan.issues.length,
      members: plan.members.length,
      photos: plan.profiles.filter(({ photo }) => photo !== null).length,
      unmatched: plan.issues
        .filter(({ kind }) => kind === 'unmatched_person')
        .map(({ body, name }) => ({ body, name })),
    };
  });
};

const fetchOrRefuse = async (
  fetcher: typeof fetch,
  url: string,
  accept: string,
): Promise<Response> => {
  try {
    return await fetcher(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'finki-hub-data (faculty structure import)',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new FacultyImportError(`${url}: unreachable or too slow`, {
      cause: error,
      code: 'FACULTY_SITE_FAILED',
    });
  }
};

const failed = (url: string, status: number): FacultyImportError =>
  new FacultyImportError(`${url}: HTTP ${String(status)}`, {
    code: 'FACULTY_SITE_FAILED',
  });

// WordPress answers a page past the last with this code.
const pastTheEnd = 'rest_post_invalid_page_number';

// The source over HTTP: a page within thirty seconds; any failure answers
// FACULTY_SITE_FAILED. A list page past the end of a REST list is an empty
// list.
export const httpFacultySource = (
  fetcher: typeof fetch = fetch,
): FacultySource => ({
  json: async (url) => {
    const response = await fetchOrRefuse(fetcher, url, 'application/json');
    const body = await response.text();
    if (response.status === 400 && body.includes(pastTheEnd)) {
      return [];
    }
    if (!response.ok) {
      throw failed(url, response.status);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new FacultyImportError(`${url}: not JSON`, {
        cause: error,
        code: 'FACULTY_SITE_FAILED',
      });
    }
  },
  text: async (url) => {
    const response = await fetchOrRefuse(fetcher, url, 'text/html');
    if (!response.ok) {
      throw failed(url, response.status);
    }
    return response.text();
  },
});

export const httpFacultyFeed = (
  site: string = defaultFacultySite,
  fetcher: typeof fetch = fetch,
): FacultyFeed => ({
  pause: () => sleep(defaultPauseMs),
  site,
  source: httpFacultySource(fetcher),
});
