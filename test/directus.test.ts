import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import type { MigrationData } from '../src/schema.js';

import { DirectusClient } from '../src/directus.js';
import { collectionSpecs } from '../src/model.js';
import {
  config,
  emptyData,
  findNamedRequest,
  recordRequests,
  toUrl,
} from './directus-test-helpers.js';

const flowPathPattern = /^\/flows\/[0-9a-f-]+$/u;

const rawTriggerResponse = { courses: 2, studentCouncilMembers: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public asset Flow', () => {
  test('provisions a visible manual flow that publishes the four public assets', async () => {
    const requests = recordRequests();

    await new DirectusClient(config).import(emptyData);

    const flowRequest = findNamedRequest(
      requests,
      '/flows',
      'Publish public assets',
    );

    expect(flowRequest?.method).toBe('POST');
    expect(
      z
        .object({
          name: z.string(),
          options: z.object({
            collections: z.array(z.string()),
            location: z.string(),
            requireSelection: z.boolean(),
          }),
          status: z.string(),
          trigger: z.string(),
        })
        .parse(flowRequest?.body),
    ).toEqual({
      name: 'Publish public assets',
      options: {
        collections: ['courses', 'rooms', 'staff', 'students'],
        location: 'collection',
        requireSelection: false,
      },
      status: 'inactive',
      trigger: 'manual',
    });

    const operations = requests.filter(
      ({ method, pathname }) => method === 'POST' && pathname === '/operations',
    );

    expect(operations).toHaveLength(7);

    const publishRequest = operations.find(({ body }) => {
      const parsed = z.object({ key: z.string() }).safeParse(body);
      return parsed.success && parsed.data.key === 'publish_assets';
    });

    expect(
      z
        .object({
          key: z.string(),
          options: z.object({
            objects: z.record(z.string(), z.string()),
            storage: z.string(),
          }),
          type: z.string(),
        })
        .parse(publishRequest?.body),
    ).toEqual({
      key: 'publish_assets',
      options: {
        objects: {
          'courses.json': '{{serialize_assets.courses}}',
          'rooms.json': '{{serialize_assets.rooms}}',
          'staff.json': '{{serialize_assets.staff}}',
          'students.json': '{{serialize_assets.students}}',
        },
        storage: 'publish',
      },
      type: 'finki-hub-publish-json',
    });

    const activationRequest = requests.at(-1);

    expect(activationRequest?.method).toBe('PATCH');
    expect(activationRequest?.pathname).toMatch(flowPathPattern);
    expect(
      z.object({ status: z.string() }).parse(activationRequest?.body),
    ).toEqual({ status: 'active' });
  });
});

describe('derived data Flow', () => {
  test('supplies collection context when invoking the manual rebuild after import', async () => {
    const requests = recordRequests();

    await new DirectusClient(config).import(emptyData);

    const flowRequest = findNamedRequest(
      requests,
      '/flows',
      'Rebuild derived data',
    );

    expect(
      z
        .object({
          name: z.string(),
          options: z.object({
            collections: z.array(z.string()),
            location: z.string(),
            requireSelection: z.boolean(),
          }),
          trigger: z.string(),
        })
        .parse(flowRequest?.body),
    ).toEqual({
      name: 'Rebuild derived data',
      options: {
        collections: [
          'courses',
          'course_enrollment_patterns',
          'curriculum_2023',
          'curriculum_2018',
          'course_equivalencies',
          'teaching_assignments',
          'moodle_users',
          'students',
          'student_council',
        ],
        location: 'collection',
        requireSelection: false,
      },
      trigger: 'manual',
    });

    const rebuildOperation = requests.find(
      ({ body, pathname }) =>
        pathname === '/operations' &&
        typeof body === 'object' &&
        body !== null &&
        'type' in body &&
        body.type === 'finki-hub-rebuild-derived-data',
    );

    expect(rebuildOperation?.body).toMatchObject({
      key: 'rebuild_derived_data',
      name: 'Rebuild derived data',
      type: 'finki-hub-rebuild-derived-data',
    });

    const triggerRequest = requests.find(({ pathname }) =>
      pathname.startsWith('/flows/trigger/'),
    );
    const triggerIndex =
      triggerRequest === undefined ? -1 : requests.indexOf(triggerRequest);
    const publishFlowRequest = findNamedRequest(
      requests,
      '/flows',
      'Publish public assets',
    );
    if (publishFlowRequest === undefined) {
      throw new Error('Publish Flow request was not recorded');
    }
    const publishFlowIndex = requests.indexOf(publishFlowRequest);

    expect(triggerIndex).toBeGreaterThan(0);
    expect(triggerIndex).toBeLessThan(publishFlowIndex);
    expect(
      z.object({ collection: z.string() }).parse(triggerRequest?.body),
    ).toEqual({ collection: 'courses' });
  });

  test('accepts the bare operation result returned by a manual Flow trigger', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = toUrl(input);
      if (url.pathname.startsWith('/flows/trigger/')) {
        return Response.json(rawTriggerResponse);
      }

      return Response.json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new DirectusClient(config).import(emptyData),
    ).resolves.toBeUndefined();
  });
});

describe('DirectusClient', () => {
  test('creates a native Studio preset for every private collection', async () => {
    const requests = recordRequests();

    await expect(
      new DirectusClient(config).import(emptyData),
    ).resolves.toBeUndefined();
    expect(requests[0]?.pathname).toBe('/collections');

    const presets = requests.filter(({ pathname }) => pathname === '/presets');
    const tabularPreset = z
      .looseObject({ collection: z.string(), layout: z.literal('tabular') })
      .refine((preset) => preset['bookmark'] === undefined);
    const collectionPresets = presets.flatMap(({ body }) => {
      const parsed = tabularPreset.safeParse(body);
      return parsed.success ? [parsed.data.collection] : [];
    });
    const searchBookmarks = presets.filter(
      ({ body }) =>
        z
          .object({
            bookmark: z.literal('Search'),
            collection: z.literal('moodle_users'),
            layout: z.literal('finki-hub-course-search'),
          })
          .safeParse(body).success,
    );

    expect(collectionPresets).toEqual(collectionSpecs.map(({ key }) => key));
    expect(searchBookmarks).toHaveLength(1);
    expect(presets).toHaveLength(14);
    expect(requests.map(({ pathname }) => pathname)).not.toContain(
      '/permissions',
    );
  });

  test('batches large private imports below the request payload limit', async () => {
    const requestedPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = toUrl(input);
      if (init?.method === 'POST') {
        requestedPaths.push(url.pathname);
      }

      return Response.json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const data: MigrationData = {
      ...emptyData,
      moodle_users: Array.from({ length: 501 }, (_, moodleId) => ({
        ID_new: moodleId,
      })),
    };

    await new DirectusClient(config).import(data);

    expect(
      requestedPaths.filter((path) => path === '/items/moodle_users'),
    ).toHaveLength(3);
  });
});
