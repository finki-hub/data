import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { runBrandingCli } from '../src/branding-run.js';
import { applyBranding } from '../src/branding.js';
import { loadBrandingConfig } from '../src/config.js';
import { createDirectusRequest } from '../src/directus-request.js';
import { exitCodes } from '../src/lifecycle.js';
import { SetupConfigError } from '../src/setup-config.js';
import { config, toUrl } from './directus-test-helpers.js';

afterEach(() => vi.unstubAllGlobals());

const appearanceField =
  /^(?:custom_css$|default_appearance$|default_theme_|project_|public_|theme_)/u;
const target = {
  DIRECTUS_TOKEN: 'test-token',
  DIRECTUS_URL: 'https://directus.test',
};
const missingTokenPattern = /^DIRECTUS_TOKEN or DIRECTUS_ADMIN_TOKEN not set$/u;
const notAbsolutePattern = /^DIRECTUS_URL not an absolute URL: "x"$/u;

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
      'POST /files: HTTP 403: Upload rejected',
    );

    expect(paths).not.toContain('/settings');
  });
});

describe('Branding configuration', () => {
  test('reads the target from the environment', () => {
    expect(loadBrandingConfig([], target)).toEqual(config);
    expect(
      loadBrandingConfig([], {
        DIRECTUS_ADMIN_TOKEN: target.DIRECTUS_TOKEN,
        DIRECTUS_URL: target.DIRECTUS_URL,
      }),
    ).toEqual(config);
  });

  test('takes no argument', () => {
    expect(() => loadBrandingConfig(['--dry-run'], target)).toThrow(
      'unexpected argument: --dry-run (accepted: none)',
    );
    expect(() => loadBrandingConfig(['--a', '--b'], target)).toThrow(
      'unexpected arguments: --a, --b (accepted: none)',
    );
  });

  test('refuses a missing token', () => {
    const withoutToken = { DIRECTUS_URL: target.DIRECTUS_URL };

    expect(() => loadBrandingConfig([], withoutToken)).toThrow(
      SetupConfigError,
    );
    expect(() => loadBrandingConfig([], withoutToken)).toThrow(
      missingTokenPattern,
    );
  });

  test('defaults to the local project and refuses a target that is not a URL', () => {
    expect(
      loadBrandingConfig([], { DIRECTUS_TOKEN: target.DIRECTUS_TOKEN }).url
        .href,
    ).toBe('http://localhost:8055/');
    expect(() =>
      loadBrandingConfig([], { ...target, DIRECTUS_URL: 'x' }),
    ).toThrow(notAbsolutePattern);
  });
});

// The branding command over the real request; fetch is stubbed per test.
const command = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    run: (arguments_: readonly string[], environment = target) =>
      runBrandingCli(arguments_, environment, {
        createRequest: createDirectusRequest,
        stderr: (line) => {
          stderr.push(line);
        },
        stdout: (line) => {
          stdout.push(line);
        },
      }),
    stderr,
    stdout,
  };
};

describe('Branding command', () => {
  test('prints one outcome line on success and exits 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        init?.body instanceof FormData
          ? Response.json({
              data: { id: '9fc1e76c-210d-4dd4-bdf6-0068a02f242f' },
            })
          : Response.json({ data: [] }),
      ),
    );
    const run = command();

    await expect(run.run([])).resolves.toBe(exitCodes.ok);
    expect(run.stdout).toEqual(['Branding succeeded']);
    expect(run.stderr).toEqual([]);
  });

  test('refuses an unexpected argument or a missing token with exit code 2', async () => {
    const fetched = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetched);
    const run = command();

    await expect(run.run(['--x'])).resolves.toBe(exitCodes.refused);
    await expect(
      run.run([], { DIRECTUS_TOKEN: '', DIRECTUS_URL: target.DIRECTUS_URL }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr).toEqual([
      'Branding refused: unexpected argument: --x (accepted: none)',
      'Branding refused: DIRECTUS_TOKEN or DIRECTUS_ADMIN_TOKEN not set',
    ]);
    expect(fetched).not.toHaveBeenCalled();
    expect(run.stdout).toEqual([]);
  });

  test('fails a refused upload with exit code 1, naming the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        init?.body instanceof FormData
          ? Response.json(
              {
                errors: [
                  { extensions: { code: 'FORBIDDEN' }, message: 'No access' },
                ],
              },
              { status: 403 },
            )
          : Response.json({ data: [] }),
      ),
    );
    const run = command();

    await expect(run.run([])).resolves.toBe(exitCodes.failed);
    expect(run.stderr).toEqual([
      'Branding failed: POST /files: HTTP 403 FORBIDDEN: No access',
    ]);
    expect(run.stdout).toEqual([]);
  });
});
