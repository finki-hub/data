const { readFileSync, writeFileSync } = require('node:fs');

const path =
  '/directus/node_modules/@directus/api/dist/services/import/import.js';
const source = readFileSync(path, 'utf8');
const original = 'createReadStream(tmpFile.path).on("error",';
if (source.split(original).length !== 2) {
  throw new Error(
    'Directus CSV source changed; review the UTF-8 patch before upgrading.',
  );
}

const replacement =
  'createReadStream(tmpFile.path, { encoding: "utf8" }).on("error",';

writeFileSync(
  path,
  source.replace(original, () => replacement),
);
