import { defineEndpoint } from '@directus/extensions-sdk';

import { curateSpec, docsContentSecurityPolicy, docsPage } from './api-docs.js';
import { forwardError } from './endpoint-errors.js';
import { legacyFiles } from './legacy-endpoint.js';

// GET /docs: the public API reference page; GET /docs/openapi.json: the
// OpenAPI document it shows (api-docs.ts). The document is built from what
// Directus generates for anonymous callers, read from this server without
// credentials, so it never names a private collection. It is rebuilt at
// most once per cacheMs.

export const docsEndpointId = 'docs';
const trailingSlash = /\/$/u;
const cacheMs = 5 * 60_000;
const fetchTimeoutMs = 15_000;

export default defineEndpoint({
  handler: (router, { env }) => {
    const port = String(env['PORT'] ?? 8_055);
    const publicUrl = String(env['PUBLIC_URL'] ?? '').replace(
      trailingSlash,
      '',
    );
    const buildSpec = async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/server/specs/oas`,
        { signal: AbortSignal.timeout(fetchTimeoutMs) },
      );
      if (!response.ok) {
        throw new Error(
          `OpenAPI specification answered ${String(response.status)}`,
        );
      }
      return curateSpec(
        (await response.json()) as Record<string, never>,
        publicUrl,
        legacyFiles.map((file) => file.filename),
      );
    };

    // One shared build per cacheMs; a failed one is dropped for the next call.
    const cache: { at: number; building: null | Promise<unknown> } = {
      at: 0,
      building: null,
    };

    const readSpec = () => {
      if (cache.building !== null && Date.now() - cache.at < cacheMs) {
        return cache.building;
      }
      const building = buildSpec();
      cache.at = Date.now();
      cache.building = building;
      return building;
    };

    const forget = (failed: Promise<unknown>) => {
      if (cache.building === failed) {
        cache.building = null;
      }
    };

    router.get('/', (_request, response) => {
      response.setHeader('Content-Security-Policy', docsContentSecurityPolicy);
      response.setHeader('Cache-Control', 'public, max-age=300');
      response.type('html').send(docsPage(`/${docsEndpointId}/openapi.json`));
    });

    router.get('/openapi.json', async (_request, response, next) => {
      const building = readSpec();
      try {
        const spec = await building;
        response.setHeader('Cache-Control', 'public, max-age=300');
        response.json(spec);
      } catch (error) {
        forget(building);
        forwardError(next, error);
      }
    });
  },
  id: docsEndpointId,
});
