import { z } from 'zod';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';

export const dataOperationsEndpoint = '/finki-hub-data-operations';
export const schemaConstraintsMigration = 'schema-constraints';

const resultSchema = z.object({
  applied: z.string(),
  statements: z.number().int().nonnegative(),
});

export type MigrationResult = z.infer<typeof resultSchema>;

export class DataOperationsUnavailableError extends Error {
  public override readonly name = 'DataOperationsUnavailableError';

  public constructor(pathname: string, options?: ErrorOptions) {
    super(
      `Directus does not serve POST ${pathname} (HTTP 404), so the composite domain keys and the generation guard were not applied. ` +
        'Build the data-operations bundle with `npm run build:operations`, restart the Directus container so it loads the bundle (GET /extensions must list the finki-hub-data-operations endpoint), then run `npm run setup` again.',
      options,
    );
  }
}

// Applies the composite domain keys and the generation guard that Directus
// cannot express through its schema API. The endpoint belongs to the
// data-operations extension bundle and only accepts bundled migrations.
export const applySchemaConstraints = async (
  request: DirectusRequest,
): Promise<MigrationResult> => {
  const pathname = `${dataOperationsEndpoint}/migrations/${schemaConstraintsMigration}`;
  try {
    return resultSchema.parse(await request(pathname, { method: 'POST' }));
  } catch (error) {
    if (error instanceof DirectusRequestError && error.status === 404) {
      throw new DataOperationsUnavailableError(pathname, { cause: error });
    }
    throw error;
  }
};
