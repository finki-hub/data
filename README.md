# FINKI Hub data migration prototype

This prototype performs a one-time import from `finki-hub.xlsx` into a fresh Directus and PostgreSQL project. It keeps the runtime stack to those two services. The migration CLI performs the one-time setup, while two small Directus operations rebuild derived data and publish the public JSON assets without another long-running service.

The TypeScript tooling follows the current FINKI Hub service conventions: npm, ESM, strict TypeScript, Zod, ESLint with `eslint-config-imperium`, and Vitest.

## Import

Requirements: Docker with Compose, Node.js 22 or newer, and npm.

1. Create the local configuration and replace every `change-*` value:

   ```sh
   cp .env.example .env
   ```

2. Install the importer dependencies and inspect the workbook without writing anything:

   ```sh
   npm ci
   npm run import:dry-run
   ```

   The command prints the row count for each imported collection.

3. Start Directus and PostgreSQL:

   ```sh
   docker compose up -d
   curl --fail http://localhost:8055/server/ping
   ```

4. Run the one-time import:

   ```sh
   npm run import
   ```

5. Open <http://localhost:8055> and sign in with `DIRECTUS_ADMIN_EMAIL` and `DIRECTUS_ADMIN_PASSWORD` from `.env`.

The importer creates 13 collections through the Directus API, adds a useful default table layout for each one, and inserts only source data from the workbook in bounded batches. It then runs the derived-data rebuild once. It deliberately refuses to run when any target collection already exists. There is no update, merge, reconciliation, or ongoing Google Sheets synchronization mode. After import, Directus is the source of truth.

If an import fails in a disposable local environment, inspect the error and recreate the local database before retrying. `docker compose down -v` deletes the prototype database permanently and must not be used against a deployment containing data.

## What gets imported

Every independent dataset in the workbook is imported. Cached spreadsheet formula results are not treated as source data. The four canonical production collections retain the existing R2 resource shapes:

| Sheet | Directus collection |
| --- | --- |
| `Предмети (Export)` | `courses` |
| `Кадар (Export)` | `staff` |
| `Простории (Export)` | `rooms` |
| `Индекси - Година`, `Индекси - Други` | `students` |

The remaining editable/reference collections are:

| Sheet | Directus collection |
| --- | --- |
| `Предмети - 2023` | `curriculum_2023` |
| `Предмети - 2018` | `curriculum_2018` |
| `Еквиваленции` | `course_equivalencies` |
| `Наставен Кадар` | `teaching_assignments` |
| `Слушатели` | `course_enrollment_patterns` |
| `Дискорд` | `discord_channels` |
| `ФСС` | `student_council` |
| `Деканат` | `deans_office` |
| `Courses` | `moodle_users` |

Spreadsheet booleans and numbers become native Directus/PostgreSQL booleans and integers. Long text and URLs use PostgreSQL text fields. Student rows are read from the two independent index sheets rather than the formula export; `source_group` preserves the cohort/legacy/external grouping. Duplicate student indices are retained.

The `courses` collection keeps manually entered course names, availability flags, tags, credits, and explicit professor or legacy-name overrides. Enrollment counts, teaching assignments, curriculum lookups, equivalencies, channel availability, and student council names are rebuilt from their source collections. The listener sheet's manually maintained regex overrides become `course_enrollment_patterns`; its cached count cells are ignored.

`moodle_users` contains names, email addresses, profile details, and course histories. Its field keys match the current [`courses-scraper`](https://github.com/finki-hub/courses-scraper) `profiles.csv` headers so future snapshots can be imported without changing the scraper output. The workbook's older `ID`, `Profile`, and `#` columns are migrated to `ID_new`, `Profile_new`, and `Courses Count`; the next scraper snapshot can also populate the old-instance and timezone fields that the workbook does not contain.

It and every other collection remain private in Directus because the importer does not create public policies or permissions.

## Import a new Courses snapshot

The current approach uses Directus's built-in CSV import and does not require changes to `courses-scraper`:

1. Run `courses-scraper` normally to produce `profiles.csv`.
2. In Directus Studio, open **Content** and then **Moodle Users**.
3. For a full replacement, select all existing items and delete them before importing. `profiles.csv` does not contain Directus's generated `id`, so importing it over existing rows would append duplicates rather than match them.
4. Open the collection's **Import / Export** sidebar, select `profiles.csv`, and choose **Import Data**.

Directus imports CSV headers as field keys and does not provide a column-mapping step. This prototype therefore follows the scraper's current 38-column output contract exactly, including `Courses Count` and `Last Access_new`. If the scraper changes that contract, update the Directus schema before importing the new format.

After importing a new snapshot, run **Rebuild derived data** from the Flows action in any affected source collection. This refreshes course enrollment counts and the other derived fields. Publishing to R2 remains a separate explicit action.

## Native previews in Directus

Directus Studio's collection table is the native replacement for the spreadsheet preview/helper tabs. The importer creates global table presets with the most useful fields and sorting. Studio search checks the displayed collection's string and numeric fields, and the filter builder supports nested include/exclude conditions.

| Spreadsheet helper | Directus replacement |
| --- | --- |
| `Пребарување` | Search/filter `moodle_users` by `Name`, `Mail`, either profile or Moodle ID field, `Courses Count`, or text contained/not contained in `Courses`. |
| `Слушатели` | Browse/filter `courses`; recent and historical `enrollment_*` fields are available as table columns. Edit exceptional matching rules in `course_enrollment_patterns`. |
| `Индекси` / `Индекси (Export)` | Search/filter the canonical `students` collection, including `source_group`. |
| `Предмети (Export)` | Browse the canonical `courses` collection. |

These are normal private Studio views, not separately stored copies. You can change visible columns, sorting, and filters in Studio and save additional presets/bookmarks for yourself or the team.

## Rebuild derived data

The importer provisions an active manual Flow named **Rebuild derived data** and executes it once after the initial source import. Run it again after changing curriculum rows, course equivalencies, teaching assignments, enrollment patterns, Moodle users, students, or student council membership. The calculated fields are read-only in Studio so their source remains unambiguous.

The rebuild Flow only updates Directus. When the data looks correct, run **Publish public assets** separately to replace the four production JSON objects.

The first rebuild can legitimately differ from the workbook's last export when a cached formula is stale or a source row is populated but its export formula was never copied. Directus always recalculates from the current source collections.

## API and R2 publishing

Directus has REST and GraphQL APIs, but this setup intentionally grants no anonymous access. Production consumers continue to fetch only the four existing JSON files from R2.

The importer provisions an active manual Flow named **Publish public assets**. It reads the four public collections, restores the existing JSON field names and string representations, and writes these stable objects through Directus's `publish` S3 storage location:

- `courses.json`
- `rooms.json`
- `staff.json`
- `students.json`

Configure the `STORAGE_PUBLISH_*` variables shown in `.env.example`. For Cloudflare R2, use the account S3 endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`), region `auto`, the existing bucket name, and an Object Read & Write token's Access Key ID and Secret Access Key. No Directus collections are public.

To publish, open any of the four public collections in Content, open the Flows action, and run **Publish public assets**. A confirmation is shown before all four files are replaced. The Flow is also visible and editable under **Settings → Flows**.

## Development checks

```sh
npm test
npm run check
npm run lint
```
