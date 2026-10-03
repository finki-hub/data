import { z } from 'zod';

// The one access check of the project, which has one user type: the
// administrator. The data-operations endpoint, the status endpoint, the
// snapshot operations and the export operation accept a caller only when
// its resolved accountability carries the administrator flag; every
// managed Flow tests the same flag in its first step (Administrator?).
const administrator = z.object({ admin: z.literal(true) });

export const isAdministrator = (accountability: unknown): boolean =>
  administrator.safeParse(accountability).success;
