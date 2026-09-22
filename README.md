# FINKI Hub data migration prototype

This prototype performs a one-time import from `finki-hub.xlsx` into a fresh Directus and PostgreSQL project. It keeps the runtime stack to those two services. The migration CLI performs the one-time setup, while two small Directus operations rebuild derived data and publish the public JSON assets without another long-running service.

The TypeScript tooling follows the current FINKI Hub service conventions: npm, ESM, strict TypeScript, Zod, ESLint with `eslint-config-imperium`, and Vitest.

## Lifecycle: setup, one-time import, upgrade

Three explicit commands install or change a project's schema, records and
Flows. A normal `docker compose up`, container restart or recreation runs
none of them: the schema, presets and Flows live in the PostgreSQL database,
and the Directus image only serves them. Each command names its target on
the invocation (`DIRECTUS_URL` plus `DIRECTUS_TOKEN` or
`DIRECTUS_ADMIN_TOKEN`, an administrator's static token); none of them reads
`.env` or falls back to a default URL. `npm run brand` also writes to a
project, but it changes nothing except the appearance settings and the
branding files, and it does read `.env` (see [Branding](#branding)).

| Situation | Command | What it does |
| --- | --- | --- |
| New, empty project | `npm run setup` | Installs the current data model, its database constraints and source-invalidation triggers, the Studio presentation, a table view per checkpoint collection, the **Search** bookmark and the Moodle history index Flow templates. Writes no records. |
| New project, first data from the spreadsheet | `npm run import` | Refuses unless every application collection is empty, runs setup, then imports the workbook once (below). |
| Project that already holds data | `npm run migrate -- --dry-run --report <private path>`, then `-- --apply` | Upgrades it in place to the relational model through the migration ledger. Never reads the workbook. |

Setup is idempotent and install-once: rerunning it creates only what is
missing. A preset (default view or bookmark) or Flow that already exists is
never changed, whoever created it, so column choices, filters and Flow
settings edited in Studio survive every rerun. Repository Flow definitions
are templates with stable ids, not a source of truth. To take a newer
template of a Moodle history index Flow, delete that Flow in Studio and run
setup again. This does not work for **Rebuild derived data** and **Publish
public assets**. Setup never installs them: the workbook import installs
them once (a project upgraded from the checkpoint importer keeps its own
copies under random ids), and the import refuses a populated project. No
command can reinstall a deleted copy, so never delete either Flow to refresh
it. If an earlier run was interrupted after creating a Flow but before
wiring it, the command stops and names the Flow to delete instead of
repairing it.

### Fresh project with the workbook

Requirements: Docker with Compose, Node.js 22 or newer, and npm.

1. Create the local Compose configuration and replace every `change-*` value:

   ```sh
   cp .env.example .env
   ```

2. Install the dependencies and inspect the workbook without writing anything
   (no credentials needed). Like the import, the dry run does not read
   `.env`: it reads the workbook named by `WORKBOOK_PATH` on the invocation,
   else `finki-hub.xlsx`, so both commands read the same file:

   ```sh
   npm ci
   WORKBOOK_PATH=finki-hub.xlsx npm run import:dry-run
   ```

   The command prints the row count for each source collection. It also
   rejects a value its column cannot hold (a string over 255 characters, an
   integer out of range) before anything is written. If the relational
   conversion would be blocked by an ambiguous relationship (see below), it
   also prints the finding counts and exits with code 3. Correct those rows
   in the workbook before importing, or plan to resolve them in Studio
   afterwards.

3. Start Directus and PostgreSQL:

   ```sh
   docker compose up -d --build
   curl --fail http://localhost:8055/server/ping
   ```

4. Run the one-time import against that project:

   ```sh
   DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=<administrator token> \
     WORKBOOK_PATH=finki-hub.xlsx npm run import
   ```

5. Apply the FINKI Hub appearance with `npm run brand`, then open
   <http://localhost:8055> and sign in with `DIRECTUS_ADMIN_EMAIL` and
   `DIRECTUS_ADMIN_PASSWORD` from `.env`.

The import reads and checks the whole workbook before it contacts Directus,
so a malformed workbook stops with nothing written and nothing published.
It then refuses, before its first write, a project in which any application
collection (the thirteen checkpoint collections, the relational collections,
the Moodle staging and index collections, the migration ledger) holds a
record, and prints the record count of each; the empty schema `npm run
setup` creates, including its coordination status row, is accepted. On an
accepted project it:

1. runs exactly what `npm run setup` runs, so importing into an empty project
   equals setup followed by the import;
2. installs the **Rebuild derived data** and **Publish public assets** Flows
   once, under stable ids (an existing Flow with that id is left as it is);
3. writes the workbook's source rows into the checkpoint collections in
   batches of 250;
4. converts those rows into the relational collections with the same
   converters, preflight and migration ledger that `npm run migrate -- --apply`
   uses, so a later `npm run migrate -- --dry-run` reports every step
   complete under the same source fingerprint;
5. runs **Rebuild derived data** once, as before. It never publishes.

If the preflight finds an ambiguous relationship that blocks the relational
conversion (for example a council index shared by two students), the rows
stay imported and the derivation still runs, but the relational conversion is
skipped and the command exits with code 3. Resolve the listed findings in
Studio, then finish with the upgrade path below.

If the import stops after it started writing rows, it exits with code 4
and the message names the phase and the one way to finish:

- **While writing rows, none confirmed:** fix the cause and run the import
  again. If the failed request stored rows after all, the import refuses and
  lists them.
- **While writing rows, some confirmed:** the project holds a partial import,
  which the import now refuses. Restore the pre-import backup, or remove
  every application record (the empty schema may stay), then import again.
  Do not upgrade the partial rows with `npm run migrate`.
- **While converting:** every row was written. Finish with `npm run migrate`
  (dry-run, then apply), whose ledger resumes the conversion, then run
  **Rebuild derived data** from Studio, since the initial rebuild did not
  run.
- **While rebuilding:** run **Rebuild derived data** from Studio. If the
  conversion was blocked, the message lists the findings; resolve them and
  finish with `npm run migrate`.

The import installs **Publish public assets** before it writes the first row.
After any interruption, do not run it until **Rebuild derived data** has run
over the complete rows, or it would replace the public files with incomplete
data.

There is no update, merge, reconciliation, or ongoing Google Sheets
synchronization mode. After import, Directus is the source of truth.

### Populated project

A project that already holds data (for example one filled by the earlier
checkpoint importer) never runs the workbook importer again. Run
`npm run setup` to add the relational collections beside the existing ones,
then `npm run migrate -- --dry-run --report <private path>`, take a backup,
and `npm run migrate -- --apply --report <private path> --backup-receipt
<private path>`. The upgrade only reads the project itself; the workbook may
be absent. Old rows and their columns are kept; relational rows are added
beside them.

`--apply` refuses without a backup receipt: a private JSON file you write
after taking the backup, next to the backup files. It names the
`sourceFingerprint` the dry run printed and every backup file with its size
in bytes and SHA-256. Paths resolve relative to the receipt, and each file
must exist with exactly the recorded size:

```json
{
  "version": "backup-receipt-1",
  "createdAt": "2026-09-22T12:00:00Z",
  "sourceFingerprint": "<sourceFingerprint from the dry-run output>",
  "artifacts": [
    {
      "path": "finki-hub.dump",
      "kind": "database",
      "bytes": 123456,
      "sha256": "<64 hex digits from sha256sum>"
    }
  ]
}
```

For the Compose stack, for example:

```sh
docker compose exec -T database pg_dump -Fc -U directus directus > finki-hub.dump
stat -c %s finki-hub.dump
sha256sum finki-hub.dump
```

Add an archive of the `uploads_data` volume as a second artifact if the
backup must cover uploaded files. Make no change between the dry run and the
apply: a changed project no longer matches the fingerprint, and `--apply`
refuses until you run a new dry run and take a new backup.

Until the old derivation is retired, `teaching_assignments` holds each
original text row plus the role-bearing rows the conversion adds for it.
Those rows repeat the original course label in `course_name`, which stays
required, so a brand-new assignment created from the course form still needs
the course label typed in; the checkpoint derivation keeps reading the
original text rows.

### Exit codes

| Code | `npm run setup` / `npm run import` |
| --- | --- |
| 0 | Done. |
| 1 | Failed before any row was written: a workbook that cannot be read or stored (nothing sent to Directus), or an unexpected error. After an unexpected error the schema or Flows may be partly installed, and rerunning is safe. |
| 2 | Refused: no explicit target, an unknown argument, a populated project offered to the import (with its record counts), existing definitions the model cannot adopt, a half-installed Flow, or a Directus without the data-operations bundle. No record was written. |
| 3 | Import only: the relational conversion is blocked until the reported findings are resolved. After a real import the workbook rows are stored; after `--dry-run` nothing was written. |
| 4 | Import only: the import stopped after it began writing rows. The message says how many rows Directus confirmed and how to finish (see above). |

`npm run migrate` exits 0 on success and 1 otherwise; its message starts with
`Migration refused` for an incompatible state and `Migration failed` for an
error.

Compose builds a local image from official Directus 12.3.1 with a one-line UTF-8 CSV decoding fix. The stock importer can corrupt multibyte characters that cross file read boundaries; the patch decodes the stream before it reaches the CSV parser. No image registry or publishing step is needed. When deliberately upgrading the base version in `directus/Dockerfile` (and the local image tag in Compose), review whether the patch is still necessary. The build stops if the expected patch target has changed, rather than silently leaving the fix unapplied.

`docker compose down -v` deletes the prototype database permanently and must not be used against a deployment containing data.

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
3. For a full replacement, delete all existing items before importing and verify the collection is empty. Studio's header checkbox selects the current page, not necessarily the entire collection. If deleting through the API with a query, specify `limit: -1` to avoid the default deletion limit. `profiles.csv` does not contain Directus's generated `id`, so importing it over existing rows would append duplicates rather than match them.
4. Open the collection's **Import / Export** sidebar, select `profiles.csv`, and choose **Start Import**.

Directus imports CSV headers as field keys and does not provide a column-mapping step. This prototype therefore follows the scraper's current 38-column output contract exactly, including `Courses Count` and `Last Access_new`. If the scraper changes that contract, update the Directus schema before importing the new format.

After importing a new snapshot, run **Rebuild derived data** from the Flows action in any affected source collection. This refreshes course enrollment counts and the other derived fields. Publishing to R2 remains a separate explicit action.

## Branding

`npm run brand` applies the shared FINKI Hub logo, favicon, login artwork,
project name, and light/dark palettes through Directus's native Files and
Settings APIs. It works on a fresh or already imported project without
reading the workbook or changing any collection data, permissions, or Flow.
Run it again to restore the repository's appearance after manual changes;
existing branding file IDs are reused. It requires the administrator token
configured in `.env` and a running Directus instance. Unlike the lifecycle
commands, it reads `DIRECTUS_URL` from `.env` and falls back to
`http://localhost:8055`, so check `.env` before running it against another
project.
Once applied, branding survives container restarts and recreation; the command
does not need to run on startup.

Edit `directus/branding/settings.json` for theme tokens, or use **Settings →
Appearance** in Studio for local adjustments. Inter is bundled with Directus;
no external fonts are required. A
small native Custom CSS override keeps informational notification text readable
on the dark theme's green background. Reapplying branding replaces that setting
too. Theme defaults follow the system preference; individual user theme overrides
still take precedence. Review the notification CSS selectors when upgrading Directus.

The unmodified logo comes from `finki-hub/courses-listing/public/logo.png`
(also shared by the timetables and diplomas projects). Branding files use the
private `local` storage location, persisted in the Compose `uploads_data`
volume. Directus serves the configured logo and public-page images to the
login screen without making collections public. They are **not** added to the
four production S3 exports. Keep both `database_data` and `uploads_data` when
moving or backing up this setup. As with the database, `down -v` deletes the
uploads volume; the repository-owned branding assets can be reapplied with
`npm run brand`.

## Native previews in Directus

Directus Studio's collection table is the native replacement for the spreadsheet preview/helper tabs. Setup creates global table presets with the most useful fields and sorting, once; later runs keep whatever Studio changed. Studio search checks the displayed collection's string and numeric fields, and the filter builder supports nested include/exclude conditions.

| Spreadsheet helper | Directus replacement |
| --- | --- |
| `Пребарување` | **Search** view on `moodle_users`, with include/exclude course pickers and matching users. |
| `Слушатели` | Browse/filter `courses`; recent and historical `enrollment_*` fields are available as table columns. Edit exceptional matching rules in `course_enrollment_patterns`. |
| `Индекси` / `Индекси (Export)` | Search/filter the canonical `students` collection, including `source_group`. |
| `Предмети (Export)` | Browse the canonical `courses` collection. |

These are normal private Studio views, not separately stored copies. You can change visible columns, sorting, and filters in Studio and save additional presets/bookmarks for yourself or the team.

### Course-history search

Open **Content → Moodle Users → Search** to use the course-history search
layout. The main **Moodle Users** view keeps the native table for regular data
management. Setup creates this shared bookmark once from
`directus/presets/course-search.json`; both views use the same collection.

- **Has all these courses:** search for and select every required course.
- **Has none of these courses:** select any courses that should exclude a person.
- Remove individual selections or clear both groups. Results update automatically,
  with a matching count, 50 people per page, profile links, and expandable histories.
- Click **Course history** to toggle between most and fewest courses first across
  all matching users. Changing the sort returns to the first page.
- The page header's native search and filters still apply. Course selections are
  temporary and reset when the layout is reopened; they are not saved bookmarks.

Choices come from the current imported Moodle histories. Matching is case-sensitive
against complete newline-separated entries, including year/semester, not substrings
or regex. The scraper's CSV format is unchanged. Up to 20 selections are supported
per group. Use **Refresh data** after importing a new snapshot to reload choices
and results. Both private endpoints use the caller's Directus permissions; no
collection data is duplicated or published to S3.

The layout and its companion endpoint are one bundle in
`directus/extensions/directus-extension-course-search`. Compiled files are included
for Compose. After changing its TypeScript or Vue sources, run `npm run build:search`,
restart Directus, and refresh Studio. Use the main **Moodle Users** view for the
standard collection editing/import/export workflow.

## Rebuild derived data

The workbook import installs an active manual Flow named **Rebuild derived data** (once, under a stable id) and executes it once after the initial source import. `npm run setup` does not install it, so do not delete it: no command can reinstall it on a project that holds data until its relational replacement lands. Run it again after changing curriculum rows, course equivalencies, teaching assignments, enrollment patterns, Moodle users, students, or student council membership. The calculated fields are read-only in Studio so their source remains unambiguous.

The rebuild Flow only updates Directus. When the data looks correct, run **Publish public assets** separately to replace the four production JSON objects.

The first rebuild can legitimately differ from the workbook's last export when a cached formula is stale or a source row is populated but its export formula was never copied. Directus always recalculates from the current source collections.

## API and R2 publishing

Directus has REST and GraphQL APIs, but this setup intentionally grants no anonymous access. Production consumers continue to fetch only the four existing JSON files from R2.

The workbook import installs an active manual Flow named **Publish public assets** (once, under a stable id). Like the rebuild Flow, it must not be deleted: setup does not install it. It reads the four public collections, restores the existing JSON field names and string representations, and writes these stable objects through Directus's `publish` S3 storage location:

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

With the local Directus stack running and an administrator token configured in `.env`, also run:

```sh
npm run test:csv
```

This integration check creates a uniquely named temporary collection, imports generated Cyrillic, CJK, and emoji text across CSV read boundaries, verifies exact field values, and deletes that test collection in cleanup. It does not read or modify the migrated collections and contains no spreadsheet or scraper data.
