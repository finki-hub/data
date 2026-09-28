import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { applyBranding } from '../src/branding.js';
import { loadBrandingConfig } from '../src/config.js';
import { createDirectusRequest } from '../src/directus-request.js';
import { config, toUrl } from './directus-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

const appearanceField =
  /^(?:custom_css$|default_appearance$|default_theme_|project_|public_|theme_)/u;

describe('Native branding', () => {
  test('uploads branding locally and changes only appearance settings', async () => {
    const forms: FormData[] = [];
    const contentTypes: boolean[] = [];
    const settings: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = toUrl(input);
        if (url.pathname === '/files' && init?.method !== 'POST') {
          return Response.json({ data: [] });
        }
        if (url.pathname === '/files' && init?.body instanceof FormData) {
          contentTypes.push(new Headers(init.headers).has('Content-Type'));
          forms.push(init.body);
          return Response.json({
            data: { id: '9fc1e76c-210d-4dd4-bdf6-0068a02f242f' },
          });
        }
        if (url.pathname === '/settings' && typeof init?.body === 'string') {
          settings.push(
            z.record(z.string(), z.unknown()).parse(JSON.parse(init.body)),
          );
          return Response.json({ data: {} });
        }
        throw new Error(`Unexpected branding request: ${url.pathname}`);
      }),
    );

    await applyBranding(createDirectusRequest(config));

    expect(forms).toHaveLength(2);
    expect(contentTypes).toEqual([false, false]);
    expect(forms.map((form) => form.get('storage'))).toEqual([
      'local',
      'local',
    ]);
    expect(
      forms.every((form) => form.get('file') instanceof Blob),
    ).toBeTruthy();
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      project_name: 'FINKI Hub',
      default_appearance: 'auto',
      project_logo: '9fc1e76c-210d-4dd4-bdf6-0068a02f242f',
    });
    expect(
      Object.keys(settings[0] ?? {}).every((key) => appearanceField.test(key)),
    ).toBeTruthy();
  });

  test('reuses existing asset IDs when branding is reapplied', async () => {
    const uploads: string[] = [];
    const id = '9fc1e76c-210d-4dd4-bdf6-0068a02f242f';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = toUrl(input);
        if (url.pathname === '/settings') return Response.json({ data: {} });
        if (init?.body instanceof FormData) {
          uploads.push(`${init.method} ${url.pathname}`);
          return Response.json({ data: { id } });
        }
        return Response.json({ data: [{ id }] });
      }),
    );

    await applyBranding(createDirectusRequest(config));

    expect(uploads).toEqual([`PATCH /files/${id}`, `PATCH /files/${id}`]);
  });

  test('does not change settings when an asset upload fails', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        paths.push(toUrl(input).pathname);
        return init?.body instanceof FormData
          ? Response.json(
              { errors: [{ message: 'Upload rejected' }] },
              { status: 403 },
            )
          : Response.json({ data: [] });
      }),
    );

    await expect(applyBranding(createDirectusRequest(config))).rejects.toThrow(
      'returned 403',
    );

    expect(paths).not.toContain('/settings');
  });
});

describe('Branding configuration', () => {
  const target = {
    DIRECTUS_TOKEN: 'test-token',
    DIRECTUS_URL: 'https://directus.test',
  };

  test('reads the target from the environment', () => {
    expect(loadBrandingConfig([], target)).toEqual(config);
    expect(
      loadBrandingConfig([], {
        DIRECTUS_ADMIN_TOKEN: 'test-token',
        DIRECTUS_URL: 'https://directus.test',
      }),
    ).toEqual(config);
  });

  test('takes no argument', () => {
    expect(() => loadBrandingConfig(['--dry-run'], target)).toThrow(
      'npm run brand takes no argument (got --dry-run).',
    );
  });

  test('refuses a missing token', () => {
    expect(() =>
      loadBrandingConfig([], { DIRECTUS_URL: 'https://directus.test' }),
    ).toThrow(z.ZodError);
  });
});
