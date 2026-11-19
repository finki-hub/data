import { writeFile } from 'node:fs/promises';

import {
  apiDocsModelPath,
  buildApiDocsModel,
  serializeApiDocsModel,
} from './api-docs-model.js';

// `npm run generate:api-docs`: rewrites the model snapshot the public API
// reference (/docs) reads, after a public collection, field, label or note
// changed. test/api-docs.test.ts fails while the snapshot is stale.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path of this repository
await writeFile(apiDocsModelPath, serializeApiDocsModel(buildApiDocsModel()));
