import { applySchemaConstraints } from './data-model/constraints.js';
import { installDataModel, SchemaRefusalError } from './data-model/install.js';
import { createDirectusRequest } from './directus-request.js';
import { loadSetupConfig } from './setup-config.js';

const main = async (): Promise<void> => {
  const request = createDirectusRequest(loadSetupConfig(process.env));
  const summary = await installDataModel(request);
  const constraints = await applySchemaConstraints(request);
  process.stdout.write(
    `${JSON.stringify({ ...summary, constraints }, null, 2)}\n`,
  );
};

try {
  await main();
} catch (error) {
  if (error instanceof SchemaRefusalError) {
    process.stdout.write(`${JSON.stringify(error.summary, null, 2)}\n`);
  }
  process.stderr.write(
    `Setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
