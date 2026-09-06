import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import settings from '../directus/branding/settings.json' with { type: 'json' };

type Request = (
  pathname: string,
  init?: Parameters<typeof fetch>[1],
) => Promise<unknown>;

const fileSchema = z.object({ id: z.uuid() });

const uploadAsset = async (
  request: Request,
  asset: {
    readonly filename: 'login-background.svg' | 'logo.png';
    readonly type: string;
  },
): Promise<string> => {
  const query = `fields=id&filter[filename_download][_eq]=finki-hub-${asset.filename}&filter[storage][_eq]=local&limit=1`;
  const [existing] = z
    .array(fileSchema)
    .parse(await request(`/files?${query}`));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only fixed repository-owned asset filenames are accepted.
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

export const applyBranding = async (request: Request): Promise<void> => {
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
