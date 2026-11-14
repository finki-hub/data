import type { DirectusConfig } from '../src/config.js';

export const config: DirectusConfig = {
  token: 'test-token',
  url: new URL('https://directus.test'),
};

export const toUrl = (input: Parameters<typeof fetch>[0]): URL => {
  if (typeof input === 'string') {
    return new URL(input);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(input.url);
};
