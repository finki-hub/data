import { z } from 'zod';

import type { DirectusConfig } from './config.js';

export type DirectusRequest = (
  pathname: string,
  init?: Parameters<typeof fetch>[1],
) => Promise<unknown>;

type DirectusErrorDetails = {
  readonly code: null | string;
  readonly reason: null | string;
  readonly status: number;
};

type DirectusErrorOptions = DirectusErrorDetails & ErrorOptions;

const responseSchema = z.object({ data: z.unknown() });
const errorBodySchema = z.object({
  errors: z
    .array(
      z.object({
        extensions: z
          .looseObject({
            code: z.string().optional(),
            reason: z.string().optional(),
          })
          .optional(),
        message: z.string().optional(),
      }),
    )
    .min(1),
});

export class DirectusRequestError extends Error {
  public override readonly name = 'DirectusRequestError';
  public readonly code: null | string;
  public readonly reason: null | string;
  public readonly status: number;

  public constructor(message: string, options: DirectusErrorOptions) {
    super(message, options);
    this.code = options.code;
    this.reason = options.reason;
    this.status = options.status;
  }
}

const parseDirectusError = (
  status: number,
  body: string,
): DirectusErrorDetails => {
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(body));
    const [first] = parsed.success ? parsed.data.errors : [];
    return {
      code: first?.extensions?.code ?? null,
      reason: first?.extensions?.reason ?? first?.message ?? null,
      status,
    };
  } catch {
    return { code: null, reason: null, status };
  }
};

export const createDirectusRequest =
  (config: DirectusConfig) =>
  async (
    pathname: string,
    init?: Parameters<typeof fetch>[1],
  ): Promise<unknown> => {
    const url = new URL(pathname, config.url);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${config.token}`);
    if (!(init?.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new DirectusRequestError(
        `${init?.method ?? 'GET'} ${url.pathname} returned ${response.status}: ${responseText}`,
        parseDirectusError(response.status, responseText),
      );
    }

    if (response.status === 204) {
      return null;
    }

    const body: unknown = await response.json();
    return responseSchema.parse(body).data;
  };
