import { z } from 'zod';

import {
  attribute,
  decodeEntities,
  elements,
  innerOf,
  region,
  textOf,
  UnrecognizedPageError,
} from './html.js';
import { normalizeEmail, type Person } from './match.js';
import { defaultPhotoName } from './vocabulary.js';

// What the import reads from the pages of finki.ukim.mk, and the rows it
// derives. Pure: the HTML of a page in, plain values out. A page that does
// not have the shape the parser knows throws UnrecognizedPageError, so a
// changed site fails the run instead of emptying the data.

export type Center = {
  readonly head: null | Person;
  readonly name: string;
  // The center's own site, when the list links one.
  readonly page: null | string;
};

export type DeanOffice = {
  // The institute heads: the heads' position text names the institute.
  readonly heads: ReadonlyArray<{
    readonly institute: string;
    readonly person: Person;
  }>;
  // The dean and the vice deans, by the position the page names.
  readonly officers: ReadonlyArray<{
    readonly person: Person;
    readonly position: string;
  }>;
};

export type InstituteLink = { readonly name: string; readonly page: string };

export type InstitutePage = {
  readonly head: null | Person;
  readonly members: readonly Person[];
};

export type KadarEntry = {
  readonly id: number;
  readonly link: string;
  readonly media: null | number;
  readonly name: string;
};

const instituteHead = /^Раководител на институт/iu;
const mailto = /href\s*=\s*"mailto:(?<address>[^"]*)"/iu;
const resumeTab = /\bid="tab-resume"/u;
const blockEnd = /<\/(?:div|h[1-6]|li|ol|p|table|tr|ul)>|<br\s*\/?>/giu;

const person = (
  name: string,
  profile: null | string,
  email: null | string,
): Person => ({ email: normalizeEmail(email), name, profile });

// The first anchor of a fragment: its address.
const hrefOf = (html: string): null | string => {
  const [anchor] = elements(html, 'a');
  return anchor === undefined ? null : attribute(anchor.open, 'href');
};

// The email a page writes as character references, in its link or its
// text.
const emailOf = (html: string): null | string => {
  const address = mailto.exec(html)?.groups?.['address'];
  return normalizeEmail(
    address === undefined ? textOf(html) : decodeEntities(address),
  );
};

// The dean's office page: the dean and vice deans, and the heads of the
// institutes with the position text that names the institute. This page is
// authoritative for the heads: an institute's own page can disagree.
export const parseDeanOffice = (html: string): DeanOffice => {
  const officers: Array<DeanOffice['officers'][number]> = [];
  const heads: Array<DeanOffice['heads'][number]> = [];
  for (const { inner } of elements(html, 'article', 'dekanat-card')) {
    const position = textOf(
      innerOf(inner, 'p', 'dekanat-card__position') ?? '',
    );
    const nameBlock = innerOf(inner, 'h3', 'dekanat-card__name') ?? '';
    const name = textOf(nameBlock);
    if (position === '' || name === '') {
      throw new UnrecognizedPageError(
        'dean office: a card without position or name',
      );
    }
    const found = person(
      name,
      hrefOf(nameBlock),
      emailOf(innerOf(inner, 'p', 'dekanat-card__email') ?? ''),
    );
    if (instituteHead.test(position)) {
      heads.push({
        institute: position.replace(instituteHead, '').trim(),
        person: found,
      });
    } else {
      officers.push({ person: found, position });
    }
  }
  if (
    officers.every(({ position }) => position !== 'Декан') ||
    heads.length === 0
  ) {
    throw new UnrecognizedPageError(
      'dean office: no dean or no institute head',
    );
  }
  return { heads, officers };
};

// The council: every member card with the profile page it links.
export const parseCouncil = (html: string): Person[] => {
  const members = elements(html, 'article', 'kadar-item').map(({ inner }) => {
    const href = hrefOf(inner);
    const name = textOf(innerOf(inner, 'p', 'kadar-item__name') ?? '');
    if (href === null || name === '') {
      throw new UnrecognizedPageError('council: a card without name or link');
    }
    return person(name, href, null);
  });
  if (members.length === 0) {
    throw new UnrecognizedPageError('council: no members');
  }
  return members;
};

// The institutes listed on the institutes page, from the link cards that
// lead to a page under the institutes path.
export const parseInstituteIndex = (
  html: string,
  institutesPath: string,
): InstituteLink[] => {
  const links = elements(html, 'a', 'link-card').flatMap(({ inner, open }) => {
    const page = attribute(open, 'href');
    const name = textOf(innerOf(inner, 'span', 'link-card__heading') ?? '');
    return page?.includes(institutesPath) === true && name !== ''
      ? [{ name, page }]
      : [];
  });
  if (links.length === 0) {
    throw new UnrecognizedPageError('institutes: no institute cards');
  }
  return links;
};

const instituteCards = (section: string): Person[] =>
  elements(section, 'a', 'institut-card').map(({ inner, open }) => {
    const name = textOf(innerOf(inner, 'span', 'institut-card__name') ?? '');
    if (name === '') {
      throw new UnrecognizedPageError('institute: a card without a name');
    }
    return person(
      name,
      attribute(open, 'href'),
      emailOf(innerOf(inner, 'span', 'institut-card__email') ?? ''),
    );
  });

// An institute's own page: its members, and the head it names (which the
// dean's office page overrules).
export const parseInstitute = (html: string): InstitutePage => {
  const members = instituteCards(
    innerOf(html, 'section', 'institut-section--members') ?? '',
  );
  const [head = null] = instituteCards(
    innerOf(html, 'section', 'institut-section--head') ?? '',
  );
  if (members.length === 0 && head === null) {
    throw new UnrecognizedPageError('institute: no head and no members');
  }
  return { head, members };
};

// The centers: one list item each, "name; Раководител" where the word is a
// link to the head's profile page.
export const parseCenters = (html: string): Center[] => {
  const body = region(html, 'page-content__body', '</article>');
  const centers = elements(body, 'li').flatMap(({ inner }) => {
    const anchors = elements(inner, 'a');
    const headAnchor = anchors.find(
      (anchor) =>
        (attribute(anchor.open, 'href') ?? '').includes('/kadar/') &&
        textOf(anchor.inner) === 'Раководител',
    );
    if (headAnchor === undefined) {
      return [];
    }
    const own = anchors.find((anchor) => anchor !== headAnchor);
    const text = textOf(
      inner.replace(`${headAnchor.open}${headAnchor.inner}</a>`, ''),
    );
    // "name; Раководител": the list's separator goes with the word.
    const name = text.endsWith(';') ? text.slice(0, -1).trim() : text;
    return name === ''
      ? []
      : [
          {
            head: person('', attribute(headAnchor.open, 'href'), null),
            name,
            page: own === undefined ? null : attribute(own.open, 'href'),
          },
        ];
  });
  if (centers.length === 0) {
    throw new UnrecognizedPageError('centers: no centers');
  }
  return centers;
};

const kadarSchema = z.array(
  z.object({
    featured_media: z.number().int().nullish(),
    id: z.number().int(),
    link: z.string(),
    title: z.object({ rendered: z.string() }),
  }),
);

// One page of the staff profile list of the WordPress REST API.
export const parseKadarList = (body: unknown): KadarEntry[] => {
  const parsed = kadarSchema.safeParse(body);
  if (!parsed.success) {
    throw new UnrecognizedPageError('profile list: unexpected response');
  }
  return parsed.data.map((entry) => ({
    id: entry.id,
    link: entry.link,
    media:
      entry.featured_media === null ||
      entry.featured_media === undefined ||
      entry.featured_media === 0
        ? null
        : entry.featured_media,
    name: textOf(entry.title.rendered),
  }));
};

const mediaSchema = z.array(
  z.object({ id: z.number().int(), source_url: z.string() }),
);

// The photo addresses of a page of the media list by id; the faculty's
// default image is no photo.
export const parseMedia = (body: unknown): Map<number, string> => {
  const parsed = mediaSchema.safeParse(body);
  if (!parsed.success) {
    throw new UnrecognizedPageError('media list: unexpected response');
  }
  return new Map(
    parsed.data
      .filter(({ source_url: url }) => !url.includes(defaultPhotoName))
      .map(({ id, source_url: url }) => [id, url]),
  );
};

// The biography of a profile page: the paragraphs of its resume tab as
// text, separated by blank lines; null when the tab is empty. A page
// without the tab is not a profile page the parser knows.
export const parseBio = (html: string): null | string => {
  const start = html.search(resumeTab);
  if (start === -1) {
    throw new UnrecognizedPageError('profile: no resume tab');
  }
  const after = html.indexOf('>', start) + 1;
  const marker = html.indexOf('id="tab-', after);
  // The next panel's opening tag starts before its id.
  const next = marker === -1 ? -1 : html.lastIndexOf('<', marker);
  const panel = html.slice(after, next === -1 ? html.length : next);
  const paragraphs = panel
    .replaceAll(blockEnd, '\n')
    .split('\n')
    .map((paragraph) => textOf(paragraph))
    .filter((paragraph) => paragraph !== '');
  return paragraphs.length === 0 ? null : paragraphs.join('\n\n');
};
