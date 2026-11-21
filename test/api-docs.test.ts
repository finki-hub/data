import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  catalogFileDescriptions,
  catalogTag,
  curateSpec,
  docsContentSecurityPolicy,
  docsGroups,
  docsPage,
  fieldDescription,
  inferSchema,
  scalarScript,
} from '../directus/extensions/directus-extension-data-operations/src/api-docs.js';
import { catalogFiles } from '../directus/extensions/directus-extension-data-operations/src/catalog-endpoint.js';
import {
  apiDocsModelPath,
  buildApiDocsModel,
  docsNotes,
  serializeApiDocsModel,
} from '../src/api-docs-model.js';
import { publicReads } from '../src/data-model/access.js';
import { folders } from '../src/data-model/presentation/navigation.js';
import { titleCase } from '../src/data-model/title-case.js';

const collator = new Intl.Collator('en');
// A pinned version in the script URL.
const pinnedVersion = /@\d+\.\d+\.\d+\//u;

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

  test('describes every /catalog file', () => {
    expect(
      Object.keys(catalogFileDescriptions).toSorted((left, right) =>
        collator.compare(left, right),
      ),
    ).toEqual(
      catalogFiles
        .map(({ filename }) => filename)
        .toSorted((left, right) => collator.compare(left, right)),
    );
  });

  test('keeps only reading the public collections, named as in Studio, and adds the /catalog files', () => {
    const raw = {
      components: {
        schemas: {
          ItemsCourses: {
            properties: {
              name: { type: 'string' },
              tags: { nullable: true, type: 'string' },
            },
          },
          ItemsCourseTeaching: {
            properties: {
              staff: {
                nullable: true,
                oneOf: [
                  { type: 'integer' },
                  { $ref: '#/components/schemas/ItemsStaff' },
                ],
              },
            },
          },
        },
      },
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
    const catalogSchemas = { 'courses.json': { items: {}, type: 'array' } };

    const spec = curateSpec(raw, {
      catalogFilenames: ['courses.json'],
      catalogSchemas,
      model: buildApiDocsModel(),
      publicUrl: 'https://data.finki-hub.com',
    });

    expect(spec['info']).toMatchObject({ title: 'FINKI Hub Data API' });
    expect(spec['servers']).toEqual([{ url: 'https://data.finki-hub.com' }]);
    expect(spec['security']).toEqual([{}]);
    expect(Object.keys(spec.paths ?? {})).toEqual([
      '/items/courses',
      '/items/courses/{id}',
      '/catalog/courses.json',
    ]);
    expect(spec.paths?.['/items/courses']).toEqual({
      get: {
        description: docsGroups[0]?.collections['courses'],
        summary: 'List Courses',
        tags: ['Courses'],
      },
    });
    expect(spec.paths?.['/items/courses/{id}']?.['get']).toMatchObject({
      summary: 'Get one Course',
    });
    expect(spec.paths?.['/catalog/courses.json']?.['get']).toMatchObject({
      responses: {
        '200': {
          content: {
            'application/json': { schema: catalogSchemas['courses.json'] },
          },
        },
      },
      tags: [catalogTag],
    });

    const schemas = (
      spec['components'] as {
        schemas: Record<
          string,
          {
            description?: string;
            properties: Record<string, Record<string, unknown>>;
          }
        >;
      }
    ).schemas;

    expect(schemas['ItemsCourses']?.description).toBe('Courses');
    expect(schemas['ItemsCourses']?.properties['name']?.['description']).toBe(
      'Name.',
    );
    // A typed nullable stays; one beside no type is dropped.
    expect(
      schemas['ItemsCourses']?.properties['tags']?.['nullable'],
    ).toBeTruthy();
    expect(schemas['ItemsCourseTeaching']?.properties['staff']).toEqual({
      description: 'Staff Member.',
      oneOf: [{ type: 'integer' }, { $ref: '#/components/schemas/ItemsStaff' }],
    });
  });
});

describe('the public API reference fields, files and page', () => {
  test('describes a field by its label, what it points to and its note', () => {
    expect(fieldDescription({ label: 'Name' })).toBe('Name.');
    expect(
      fieldDescription({
        label: 'Course',
        related: { collection: 'courses', label: 'Course', many: false },
      }),
    ).toBe('Course.');
    expect(
      fieldDescription({
        label: 'Mentor',
        related: { collection: 'staff', label: 'Staff Member', many: false },
      }),
    ).toBe('Mentor (Staff Member).');
    expect(
      fieldDescription({
        label: 'Teaches',
        related: {
          collection: 'teaching_assignments',
          label: 'Manual Teaching Staff',
          many: true,
        },
      }),
    ).toBe('Teaches (list of Manual Teaching Staff).');
    expect(
      fieldDescription({
        label: 'FINKI Staff',
        note: 'Off for other faculties.',
      }),
    ).toBe('FINKI Staff. Off for other faculties.');
  });

  test("reads a /catalog file's shape from the file", () => {
    expect(
      inferSchema([
        { name: 'A', semester: 1 },
        { name: 'B', semester: 2, tags: 'x' },
        { name: 'C', semester: null },
      ]),
    ).toEqual({
      items: {
        properties: {
          name: { type: 'string' },
          semester: { type: 'integer' },
          tags: { type: 'string' },
        },
        required: ['name'],
        type: 'object',
      },
      type: 'array',
    });
    expect(inferSchema(['a', 'b'])).toEqual({
      items: { type: 'string' },
      type: 'array',
    });

    const sessions = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `Сесија ${String(index)}`,
        `${String(index)}.xlsx`,
      ]),
    );

    expect(inferSchema(sessions)).toEqual({
      additionalProperties: { type: 'string' },
      type: 'object',
    });

    // A row is a record however many keys it has.
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`key${String(index)}`, 'x']),
    );

    expect(inferSchema([wide])).toMatchObject({
      items: { properties: { key0: { type: 'string' } }, type: 'object' },
    });
  });

  test('reads a model snapshot generated from the current model', () => {
    // npm run generate:api-docs rewrites the snapshot.
    expect(apiDocsModelPath).toBe(
      'directus/extensions/directus-extension-data-operations/src/api-docs-model.json',
    );
    expect(
      readFileSync(
        'directus/extensions/directus-extension-data-operations/src/api-docs-model.json',
        'utf8',
      ),
    ).toBe(serializeApiDocsModel(buildApiDocsModel()));
  });

  test('replaces only the notes of public fields', () => {
    const { collections } = buildApiDocsModel();
    const shown = Object.keys(docsNotes).map((key) => {
      const [collection = '', field = ''] = key.split('.', 2);
      return [key, collections[collection]?.fields[field]?.note] as const;
    });

    expect(Object.fromEntries(shown)).toStrictEqual(docsNotes);
  });

  test('loads the reference from the pinned script the page policy allows', () => {
    const page = docsPage('/docs/openapi.json');

    expect(page).toContain(`data-url="/docs/openapi.json"`);
    expect(page).toContain(scalarScript);
    expect(scalarScript).toMatch(pinnedVersion);
    expect(docsContentSecurityPolicy).toContain(
      "script-src 'self' https://cdn.jsdelivr.net",
    );

    // Every script tag loads a file or carries the reference's data; none
    // holds inline code the page policy would have to allow.
    const scriptTags = page
      .toLowerCase()
      .split('<script')
      .slice(1)
      .map((tag) => tag.slice(0, tag.indexOf('>')));

    expect(scriptTags).toHaveLength(2);

    for (const tag of scriptTags) {
      expect(tag.includes(' src=') || tag.includes(' data-url=')).toBeTruthy();
    }
  });
});
