import { describe, expect, test } from 'vitest';

import {
  curateSpec,
  docsContentSecurityPolicy,
  docsGroups,
  docsPage,
  legacyFileDescriptions,
  legacyTag,
  scalarScript,
} from '../directus/extensions/directus-extension-data-operations/src/api-docs.js';
import { legacyFiles } from '../directus/extensions/directus-extension-data-operations/src/legacy-endpoint.js';
import { publicReads } from '../src/data-model/access.js';
import { folders } from '../src/data-model/presentation/navigation.js';
import { titleCase } from '../src/data-model/title-case.js';

const collator = new Intl.Collator('en');
// A pinned version in the script URL, and an inline script in the page.
const pinnedVersion = /@\d+\.\d+\.\d+\//u;
const inlineScript = /<script>[^<]/u;

const documented = docsGroups.flatMap(({ collections }) =>
  Object.keys(collections),
);

describe('the public API reference', () => {
  test('describes every public collection exactly once', () => {
    expect(
      documented.toSorted((left, right) => collator.compare(left, right)),
    ).toEqual(
      publicReads
        .map(({ collection }) => collection)
        .toSorted((left, right) => collator.compare(left, right)),
    );
    expect(new Set(documented).size).toBe(documented.length);
  });

  test('groups each collection under its Studio folder, helpers with their subject', () => {
    const internals = folders.find(
      ({ collection }) => collection === 'folder_internals',
    );
    for (const group of docsGroups) {
      const folder = folders.find(
        ({ label }) => titleCase(label) === group.name,
      );

      expect(folder?.collection).toBeDefined();

      for (const collection of Object.keys(group.collections)) {
        expect([
          ...(folder?.members ?? []),
          ...(internals?.members ?? []),
        ]).toContain(collection);
      }
    }
  });

  test('describes every /legacy file', () => {
    expect(
      Object.keys(legacyFileDescriptions).toSorted((left, right) =>
        collator.compare(left, right),
      ),
    ).toEqual(
      legacyFiles
        .map(({ filename }) => filename)
        .toSorted((left, right) => collator.compare(left, right)),
    );
  });

  test('keeps only reading the public collections, adds the /legacy files', () => {
    const raw = {
      components: { schemas: { ItemsCourses: {} } },
      info: { title: 'Dynamic API Specification' },
      openapi: '3.0.1',
      paths: {
        '/auth/login': { post: {} },
        '/items/courses': { get: { summary: 'List Items' }, post: {} },
        '/items/courses/{id}': {
          delete: {},
          get: { summary: 'Retrieve an Item' },
        },
        '/items/moodle_users': { get: {} },
        '/server/ping': { get: {} },
      },
    };

    const spec = curateSpec(raw, 'https://data.finki-hub.com', [
      'courses.json',
    ]);

    expect(spec['info']).toMatchObject({ title: 'FINKI Hub Data API' });
    expect(spec['servers']).toEqual([{ url: 'https://data.finki-hub.com' }]);
    expect(spec['components']).toEqual(raw.components);
    expect(Object.keys(spec.paths ?? {})).toEqual([
      '/items/courses',
      '/items/courses/{id}',
      '/legacy/courses.json',
      '/legacy/sessions/{file}',
    ]);
    expect(spec.paths?.['/items/courses']).toEqual({
      get: {
        description: docsGroups[0]?.collections['courses'],
        summary: 'List courses',
        tags: ['Courses'],
      },
    });
    expect(spec.paths?.['/legacy/courses.json']?.['get']).toMatchObject({
      tags: [legacyTag],
    });
  });

  test('loads the reference from the pinned script the page policy allows', () => {
    const page = docsPage('/docs/openapi.json');

    expect(page).toContain(`data-url="/docs/openapi.json"`);
    expect(page).toContain(scalarScript);
    expect(scalarScript).toMatch(pinnedVersion);
    expect(docsContentSecurityPolicy).toContain(
      "script-src 'self' https://cdn.jsdelivr.net",
    );
    expect(page).not.toMatch(inlineScript);
  });
});
