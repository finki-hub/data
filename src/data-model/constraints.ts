import { z } from 'zod';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';

export const dataOperationsEndpoint = '/finki-hub-data-operations';
export const schemaConstraintsMigration = 'schema-constraints';
export const sourceInvalidationMigration = 'source-invalidation';

const resultSchema = z.object({
  applied: z.string(),
  statements: z.number().int().nonnegative(),
});

type MigrationResult = z.infer<typeof resultSchema>;

export class DataOperationsUnavailableError extends Error {
  public override readonly name = 'DataOperationsUnavailableError';

  public constructor(pathname: string, options?: ErrorOptions) {
    super(
      `Directus does not serve POST ${pathname} (HTTP 404), so the composite domain keys, the generation guard and the source-invalidation triggers were not applied. ` +
        'Build the data-operations bundle with `npm run build:operations`, restart the Directus container so it loads the bundle (GET /extensions must list the finki-hub-data-operations endpoint), then run `npm run setup` again.',
      options,
    );
  }
}

// Runs one bundled migration through the admin-only endpoint of the
// data-operations extension bundle; only bundled names are accepted there.
const applyMigration = async (
  request: DirectusRequest,
  name: string,
): Promise<MigrationResult> => {
  const pathname = `${dataOperationsEndpoint}/migrations/${name}`;
  try {
    return resultSchema.parse(await request(pathname, { method: 'POST' }));
  } catch (error) {
    if (error instanceof DirectusRequestError && error.status === 404) {
      throw new DataOperationsUnavailableError(pathname, { cause: error });
    }
    throw error;
  }
};

// Applies the composite domain keys and the generation guard that Directus
// cannot express through its schema API.
export const applySchemaConstraints = (
  request: DirectusRequest,
): Promise<MigrationResult> =>
  applyMigration(request, schemaConstraintsMigration);

// Installs the statement-level source-invalidation triggers that bump the
// source revision and mark the affected domains inside every source
// transaction. Requires the data model, whose status columns it updates.
export const applySourceInvalidation = (
  request: DirectusRequest,
): Promise<MigrationResult> =>
  applyMigration(request, sourceInvalidationMigration);
