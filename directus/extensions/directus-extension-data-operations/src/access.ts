import { z } from 'zod';

// The caller check of the bundle's endpoints and of the operations that
// read or write with system rights, where Directus checks nothing itself:
// a request without a signed-in user is refused 401, a signed-in user
// whose accountability lacks the admin flag 403.

export type CallerRefusal = {
  readonly message: string;
  readonly reason: 'FORBIDDEN' | 'UNAUTHENTICATED';
  readonly status: 401 | 403;
};

const accountabilitySchema = z.looseObject({
  admin: z.boolean().optional(),
  role: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
});

const unauthenticated: CallerRefusal = {
  message: 'Authentication required',
  reason: 'UNAUTHENTICATED',
  status: 401,
};

const forbidden: CallerRefusal = {
  message: 'Forbidden',
  reason: 'FORBIDDEN',
  status: 403,
};

// The refusal of a caller, or null when it is accepted. An accountability
// without a user and a role is anonymous: a null accountability is never
// taken for the system here.
export const callerRefusal = (
  accountability: unknown,
): CallerRefusal | null => {
  const parsed = accountabilitySchema.safeParse(accountability);
  if (!parsed.success) {
    return unauthenticated;
  }
  const { admin = false, role = null, user = null } = parsed.data;
  if (user === null && role === null) {
    return unauthenticated;
  }
  return admin ? null : forbidden;
};

// The refusal of an endpoint request, by its resolved accountability.
export const requestRefusal = (request: object): CallerRefusal | null =>
  callerRefusal('accountability' in request ? request.accountability : null);
