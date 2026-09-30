import { z } from 'zod';

// How the Search layout names a failed request, one line for every
// subject: `<Subject> failed: HTTP <status> <CODE>`, then the server's own
// message unless the caller was refused (401, 403); `<Subject> failed: no
// response` without an answer; `<Subject> failed: invalid response` for an
// answer of another shape. The Retry button beside it offers the retry.

const errorAnswer = z.object({
  response: z.object({
    data: z
      .object({
        errors: z
          .array(
            z.object({
              extensions: z
                .looseObject({ code: z.string().optional() })
                .optional(),
              message: z.string().optional(),
            }),
          )
          .min(1),
      })
      .optional(),
    status: z.number().int(),
  }),
});

// How much of a server message the line keeps.
const messageLength = 300;

const bounded = (value: string): string =>
  value.length > messageLength ? `${value.slice(0, messageLength)}…` : value;

export const failureText = (subject: string, error: unknown): string => {
  if (error instanceof z.ZodError) {
    return `${subject} failed: invalid response`;
  }
  const answer = errorAnswer.safeParse(error);
  if (!answer.success) {
    return `${subject} failed: no response`;
  }
  const { data, status } = answer.data.response;
  const [first] = data?.errors ?? [];
  const code = first?.extensions?.code;
  const http =
    code === undefined ? String(status) : `${String(status)} ${code}`;
  const head = `${subject} failed: HTTP ${http}`;
  const message = first?.message ?? '';
  return status === 401 || status === 403 || message === ''
    ? head
    : `${head}: ${bounded(message)}`;
};
