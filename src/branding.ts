import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

import settings from '../directus/branding/settings.json' with { type: 'json' };

const fileSchema = z.object({ id: z.uuid() });

const uploadAsset = async (
  request: DirectusRequest,
  asset: {
    readonly filename: 'login-background.svg' | 'logo.png';
    readonly type: string;
  },
): Promise<string> => {
  const query = `fields=id&filter[filename_download][_eq]=finki-hub-${asset.filename}&filter[storage][_eq]=local&limit=1`;
  const [existing] = z
    .array(fileSchema)
    .parse(await request(`/files?${query}`));
  const bytes = await readFile(
    new URL(`../directus/branding/${asset.filename}`, import.meta.url),
  );
  const form = new FormData();
  form.set('storage', 'local');
  form.set('title', `FINKI Hub ${asset.filename}`);
  form.set('filename_download', `finki-hub-${asset.filename}`);
  form.set(
    'file',
    new Blob([new Uint8Array(bytes)], { type: asset.type }),
    `finki-hub-${asset.filename}`,
  );
  const result = await request(existing ? `/files/${existing.id}` : '/files', {
    body: form,
    method: existing ? 'PATCH' : 'POST',
  });
  return fileSchema.parse(result).id;
};

export const applyBranding = async (
  request: DirectusRequest,
): Promise<void> => {
  const logo = await uploadAsset(request, {
    filename: 'logo.png',
    type: 'image/png',
  });
  const background = await uploadAsset(request, {
    filename: 'login-background.svg',
    type: 'image/svg+xml',
  });
  await request('/settings', {
    body: JSON.stringify({
      ...settings,
      project_logo: logo,
      public_background: background,
      public_favicon: logo,
      public_foreground: logo,
    }),
    method: 'PATCH',
  });
};
