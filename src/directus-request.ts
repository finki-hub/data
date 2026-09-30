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

// How long one request may take.
const requestTimeoutMs = 120_000;

// How much of a response body that is no Directus error a message keeps.
const bodyExcerptLength = 200;

const causeCodeSchema = z.object({ code: z.string() });

const whitespace = /\s+/u;

// The start of a body that is no Directus error, on one line.
const excerptOf = (body: string): null | string => {
  const excerpt = body
    .slice(0, bodyExcerptLength * 4)
    .split(whitespace)
    .join(' ')
    .trim()
    .slice(0, bodyExcerptLength);
  return excerpt === '' ? null : excerpt;
};

// The fault of an answered request: `HTTP <status>[ <CODE>][: <reason>]`,
// with the start of the body when it is no Directus error.
const httpFault = (details: DirectusErrorDetails, body: string): string => {
  const status = `HTTP ${String(details.status)}`;
  const head = details.code === null ? status : `${status} ${details.code}`;
  const reason =
    details.reason ?? (details.code === null ? excerptOf(body) : null);
  return reason === null ? head : `${head}: ${reason}`;
};

// A request no answer came back to: timed out, or refused by the network
// with the cause's code (such as ECONNREFUSED).
const unanswered = (place: string, error: unknown): Error => {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new Error(
      `${place}: timed out after ${String(requestTimeoutMs / 1_000)} s`,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = causeCodeSchema.safeParse(
    error instanceof Error ? error.cause : undefined,
  );
  const code = cause.success ? cause.data.code : message;
  return new Error(`${place}: no response (${code})`, { cause: error });
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
    const place = `${init?.method ?? 'GET'} ${url.pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw unanswered(place, error);
    }

    if (!response.ok) {
      const responseText = await response.text();
      const details = parseDirectusError(response.status, responseText);
      throw new DirectusRequestError(
        `${place}: ${httpFault(details, responseText)}`,
        details,
      );
    }

    if (response.status === 204) {
      return null;
    }

    const body: unknown = await response.json();
    return responseSchema.parse(body).data;
  };
