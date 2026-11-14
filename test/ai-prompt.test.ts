import { describe, expect, test } from 'vitest';

import type { DirectusRequest } from '../src/directus-request.js';

import {
  directusDefaultPrompt,
  finkiHubContext,
  installSystemPrompt,
  systemPrompt,
} from '../src/ai-prompt.js';
import { dataModelCollectionKeys } from '../src/data-model/collections.js';

const identifier = /`(?<name>[a-z_]+)`/gu;
const opening = /^<behavior_instructions>/u;
const closing = /<\/behavior_instructions>$/u;

type Write = { readonly body: unknown; readonly path: string };

const directusWith = (stored: null | string) => {
  const writes: Write[] = [];
  const request: DirectusRequest = (path, init) => {
    if (init?.method === 'PATCH') {
      writes.push({
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        path,
      });
      return Promise.resolve(null);
    }
    return Promise.resolve({ ai_system_prompt: stored });
  };
  return { request, writes };
};

describe('the AI assistant system prompt', () => {
  test("keeps Directus's own tool instructions first and adds the FINKI Hub context", () => {
    expect(directusDefaultPrompt).toMatch(opening);
    expect(directusDefaultPrompt).toMatch(closing);
    expect(systemPrompt).toBe(
      `${directusDefaultPrompt}\n\n${finkiHubContext}\n`,
    );
    expect(finkiHubContext).toContain('**Private data**');
  });

  test('names only collections of the model', () => {
    const named = finkiHubContext
      .matchAll(identifier)
      .map((match) => match.groups?.['name'] ?? '')
      .toArray();

    expect(named).toContain('students');
    expect(
      named.filter(
        (name) =>
          !(dataModelCollectionKeys as readonly string[]).includes(name),
      ),
    ).toEqual([]);
  });

  test('is written when the stored prompt differs', async () => {
    const { request, writes } = directusWith('an edit in Settings');

    await expect(installSystemPrompt(request)).resolves.toEqual({
      prompt: 'written',
    });
    expect(writes).toEqual([
      { body: { ai_system_prompt: systemPrompt }, path: '/settings' },
    ]);
  });

  test('is left alone when it is already stored', async () => {
    const { request, writes } = directusWith(systemPrompt);

    await expect(installSystemPrompt(request)).resolves.toEqual({
      prompt: 'unchanged',
    });
    expect(writes).toEqual([]);
  });
});
