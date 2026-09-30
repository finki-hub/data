const { readFileSync, writeFileSync } = require('node:fs');

const path =
  '/directus/node_modules/@directus/api/dist/services/import/import.js';
const source = readFileSync(path, 'utf8');
const original = 'createReadStream(tmpFile.path).on("error",';
const matches = source.split(original).length - 1;
if (matches !== 1) {
  throw new Error(
    `UTF-8 CSV import patch failed: import.js matches ${matches}, expected 1`,
  );
}

const replacement =
  'createReadStream(tmpFile.path, { encoding: "utf8" }).on("error",';

writeFileSync(
  path,
  source.replace(original, () => replacement),
);
