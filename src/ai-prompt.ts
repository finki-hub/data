import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { DirectusRequest } from './directus-request.js';

// The system prompt of the Studio AI assistant (and the MCP server's
// system-prompt tool). Directus uses a custom prompt instead of its own,
// not beside it, so the custom one is Directus's default prompt
// (directus/ai/directus-default-prompt.md, a copy of the installed
// version's, which the Integration workflow compares with the running
// Directus) followed by the FINKI Hub context (finki-hub-context.md). The
// prompt is owned by the repository: setup writes it whenever the stored one
// differs, so edit the files, not Settings → AI.

const read = (url: URL): string => readFileSync(url, 'utf8').trim();

export const directusDefaultPrompt = read(
  new URL('../directus/ai/directus-default-prompt.md', import.meta.url),
);

export const finkiHubContext = read(
  new URL('../directus/ai/finki-hub-context.md', import.meta.url),
);

export const systemPrompt = `${directusDefaultPrompt}\n\n${finkiHubContext}\n`;

export type AiPromptSummary = { readonly prompt: 'unchanged' | 'written' };

const settingsSchema = z.object({ ai_system_prompt: z.string().nullable() });

export const installSystemPrompt = async (
  request: DirectusRequest,
): Promise<AiPromptSummary> => {
  const settings = settingsSchema.parse(
    await request('/settings?fields=ai_system_prompt'),
  );
  if (settings.ai_system_prompt === systemPrompt) {
    return { prompt: 'unchanged' };
  }
  await request('/settings', {
    body: JSON.stringify({ ai_system_prompt: systemPrompt }),
    method: 'PATCH',
  });
  return { prompt: 'written' };
};
