# FINKI Hub data

The Directus project that holds the FINKI Hub data: courses and their
curricula, staff, rooms, students, the student council, the dean's office,
Discord channels, the Moodle course-history snapshot and the enrollment
counts derived from it. Directus is the source of truth: every change is
made in Directus, and every consumer reads it through the Directus API.

The live instance is <https://data.finki-hub.com>.

## What is in this repository

| Path | What it holds |
| --- | --- |
| `src/data-model/` | The schema as code: every collection, field, relation, label and Studio presentation `npm run setup` installs. |
| `src/flows/` | The managed Flows: Moodle snapshot import, history index, enrollment counts and their schedule, and the timetable import. |
| `directus/extensions/directus-extension-data-operations/` | The coordinator of the derived data, the snapshot import, the write guards, the dashboard panels, the status endpoint and the `/legacy` endpoint. |
| `directus/extensions/directus-extension-course-search/` | The **Search** layout over Moodle users (has all of / none of these courses). |
| `directus/branding/` | Logo, login artwork and theme, applied by `npm run brand`. |
| `test/` | Unit and contract tests (`npm test`), plus two opt-in integration suites. |

The `Dockerfile` builds the image `ghcr.io/finki-hub/data`: the official
Directus image with the CSV-import patch (`directus/patch-csv-import.cjs`)
and both extensions built in from source; their bundles (`dist/`) are build
output and not committed.

## Reading the data

The data is public and read-only for anonymous callers, with CORS open:

- **REST:** `GET https://data.finki-hub.com/items/<collection>`, with the
  usual Directus `fields`, `filter`, `sort`, `limit` and `deep` parameters,
  for example `/items/courses?fields=name,abbreviation,discord_channels.discord_channel.channel`.
- **GraphQL:** `POST https://data.finki-hub.com/graphql`.
- **Schema:** `GET /collections`, `/fields` and `/relations` describe every
  public collection.

Public collections: `courses`, `course_curricula`, `curriculum_entries`,
`curriculum_entry_program_states`, `curriculum_generations`,
`study_programs`, `course_equivalencies`, `course_equivalency_members`,
`course_enrollments`, `academic_years`, `staff`, `teaching_assignments`,
`course_teaching`, `course_accreditation_staff`, `timetables`,
`timetable_lessons`, `rooms`, `deans_office`, `discord_channels`,
`discord_channel_courses`, `student_council`, `exam_sessions` and
`anto_quotes`. Students are public only as council members (name and
index number); every other student, every Moodle user and the operations
bookkeeping stay private. These read permissions (and the `MCP` role's
identical ones) are declared in `src/data-model/access.ts` and created by
`npm run setup`.

### The legacy JSON files

`GET https://data.finki-hub.com/legacy/<file>` serves `courses.json`,
`rooms.json`, `staff.json`, `sessions.json` and `anto.json` in exactly the
format the old assets bucket published, built from the live data, and
`GET /legacy/sessions/<file name>` the schedule file an exam session links,
so a consumer only swaps its base URL. The definitions live in
`directus/extensions/directus-extension-data-operations/src/exports/`. A
file is rebuilt at most once a minute and carries its SHA-256 as the
`ETag`; when a rebuild fails (for example an Active course without a
professor), the last good file keeps being served.

### MCP

Directus's built-in MCP server is enabled at
`https://data.finki-hub.com/mcp`. It needs a static token of a user; the
`MCP` role reads exactly what the public API reads.

### AI assistant

Studio's AI assistant uses the OpenAI key set in **Settings → AI**. Its
system prompt is owned by this repository and installed by setup: Directus's
own prompt (`directus/ai/directus-default-prompt.md`, repeated because a
custom prompt replaces it) followed by the
FINKI Hub context (`directus/ai/finki-hub-context.md`: the private
collections, the derived data and that the schema lives in code). The
Integration workflow fails when a Directus release changes its own prompt, so
the copy is refreshed. Edit the files, not the setting.

## Data model

The model is declared in `src/data-model/` and installed by
`npm run setup`. The main collections:

- **Courses** (`courses`): name, English name (the official one from FINKI's
  English subject pages, published as `name-en`), abbreviation, tags,
  teaching status and the syllabus: degree cycle, objectives and content in
  Macedonian and English, from FINKI's subject page of the course's 2023
  curriculum entry (2018 for a course with none). The syllabus is in the API,
  not in `courses.json`.
  Their curriculum lives in **Curriculum links** (`course_curricula`, one
  per generation), who taught them in each semester in **Course teaching**
  (`course_teaching`, from the timetables, below), their syllabus teachers
  in **Accreditation teachers** (`course_accreditation_staff`), hand-kept
  staff in **Teaching staff** (`teaching_assignments`), their Discord
  channels in `discord_channel_courses`. `courses.json` publishes as
  professors and assistants who taught the course in the six latest main
  timetables (three years), grouped by position, else
  its accreditation teachers as professors, else its hand-kept staff; a
  status of All professors or Inactive replaces them as before.
- **Curriculum** (`curriculum_generations`, `study_programs`,
  `curriculum_entries`, `curriculum_entry_program_states`,
  `course_equivalencies`, `course_equivalency_members`): the 2013, 2018
  and 2023 curricula as rows. A generation, program or academic year
  reaches `courses.json` only once its **Published** flag is set.
- **Staff, rooms, dean's office, students, student council and Discord
  channels**: plain lists. A course may have several Discord channels (an
  undergraduate and a master's one).
- **Exam sessions and Anto quotes** (`exam_sessions`, `anto_quotes`): what
  the bots publish beside the course data. A session's schedule is
  uploaded on its form; the file lands in the R2 storage location.
- **Moodle users** (`moodle_users`): the scraper's snapshot, replaced as a
  whole (below).
- **Derived** (`moodle_course_entries`, `moodle_history_memberships`,
  `moodle_counted_lines`, `course_enrollments`): rebuilt by the Flows,
  never edited by hand. The database refuses any other writer.

Database rules Directus cannot express (composite unique keys, curriculum
guards, write guards of the derived tables and the statement triggers that
mark the derived data stale) are bundled migrations of the data-operations
extension that setup applies.

## Enrollment counts

A course's count for an academic year is the number of distinct Moodle
accounts holding at least one history line counted for that course and
year. Two kinds of mapping count a line:

- a **Pattern mapping** tests its pattern against each history line and,
  for an all-years mapping, reads the year from the line with its year
  pattern; an only-in-year mapping counts its lines in its own year;
- an **Explicit mapping** maps one history line to a course and year by
  hand, and then overrides every pattern for that line.

A new course gets the default mapping `<name>-` automatically. The counts
refresh by themselves: every edit of a source table marks the history
index or the counts pending inside its own transaction, and **Data /
Process pending** (every 15 seconds) runs the first pending one. **Data /
Mark pending** (the **Recalculate** panel) marks them pending by hand and
retries a failed run. The **Unmapped history lines** bookmark lists the
lines no mapping counts.

## Teaching staff from the timetables

**Data / Import timetables daily** (04:30) reads
[timetables-api.finki-hub.com](https://github.com/finki-hub/timetables-listing),
which keeps every EduPage timetable in R2. It stores every listed timetable
in `timetables` and, for the main timetable of each semester (the one that
starts last), its lessons in `timetable_lessons`: the weekly periods of each
subject, class type and teacher. It fetches the visible timetables and those
never imported; **Data / Import timetables** on the dashboard does the same
by hand, or fetches every one again.

`course_teaching` is derived from the lessons in the same transaction: each
staff member's weekly periods of a course in each main timetable, as
professor when their position is Редовен професор, Вонреден професор,
Доцент, Насловен вонреден професор or Професор во пензија and assistant
otherwise, whatever classes they held. A subject matches a course by its name, English name or a linked
curriculum entry's name, and a combined slot "A / B" when each part does; a
teacher matches a staff member by name, with either of two surnames left
out. Anything else needs an alias: **Timetable course names**
(`course_aliases`) and **Timetable staff names** (`staff_aliases`) map a
timetable name to a course or staff member, or ignore it without one. Every
edit of an alias, a course, a staff member or a curriculum entry rebuilds
`course_teaching` at once. Filtering `timetable_lessons` by **Course match**
or **Teacher match** Unmatched lists what still needs an alias.

All three tables are written only by the import and its rebuild. The
import also marks the six latest main timetables **Published**
(`timetables.recent`): the window `courses.json` reads.

## Replacing the Moodle snapshot

The snapshot comes from
[`courses-scraper`](https://github.com/finki-hub/courses-scraper), unchanged.
It refreshes itself every Sunday: the host's `directus-moodle-sync.timer`
(in `deploy/`) runs the `moodle-sync` service of `compose.prod.yaml`, which
scrapes the new Moodle instance over the newest `profiles-*.csv` in
**Moodle snapshots (private)** (the old instance no longer changes), checks
that no profile was lost, uploads the result there and runs the import
below. It keeps the newest 8 exports and 8 import backups, and a failure
posts a Discord alert. To run it now: `systemctl start directus-moodle-sync`.

By hand:

1. Run the scraper to produce `profiles.csv` (its 38 headers, no `id`).
2. Upload it to the File Library folder **Moodle snapshots (private)**.
3. Run **Import Moodle snapshot** on the **Data operations** dashboard,
   pick the file and confirm **Replace the whole active Moodle snapshot**.

The import stages and validates the file, writes a private backup CSV of
the current Moodle users, then replaces them in one step. Every edit made
to a Moodle user in Studio since the last import is replaced too; mappings
and every other collection are kept. The history index and counts then
refresh on their own.

## The Data operations dashboard

**Insights → Data operations** shows the calculations and their last
failure, the Moodle snapshot counts and the rows whose **Published** flags
decide the keys of `courses.json`, with **Recalculate** and **Import Moodle
snapshot** buttons. A manual Flow named `Data / …` can be added as another
button with no code change.

## Deployment

CI builds and pushes `ghcr.io/finki-hub/data` on every push, and weekly so
new Directus 12 releases arrive without a commit (a new major version only
by changing the `FROM` line of the `Dockerfile`). `compose.prod.yaml`, the
host's compose file, runs it with PostgreSQL; its secrets come from env
files beside it (`secrets.env`, `licence.env`, `storage.env`, `sso.env`
and `moodle-sync.env`, listed in the file), never from this repository. On the `finki-hub` host, Caddy proxies
`data.finki-hub.com` to it.

To deploy a change:

1. Nothing for code: Watchtower on the host pulls each new image and
   recreates the `directus` container within the hour.
2. When the model, a Flow or a migration changed, run setup against the
   instance:

   ```sh
   DIRECTUS_URL=http://127.0.0.1:8055 DIRECTUS_ADMIN_TOKEN=... npm run setup
   ```

Setup is idempotent: it creates what is missing, realigns enum choices,
applies the migrations and never overwrites a Studio edit of a preset,
Flow, panel, folder or permission. It never writes a data record. A request
the rate limiter refuses is retried, so setup runs with the limiter on.

## Changing the model

Edit the declaration in `src/data-model/` (and the presentation in
`src/data-model/presentation/` when Studio should show it differently),
update the tests that pin it, run `npm test`, then deploy and run setup.
A new public field also needs adding to the Public policy's read
permission on the instance.

A collection's role in the coordinator (content, source of a calculation,
derived, staging or status) is declared once in
`coordination/collection-roles.ts`; after changing it, run
`npm run generate:invalidation` to refresh the reviewed SQL snapshot.

## Development

| Command | What it does |
| --- | --- |
| `npm test` | Every unit and contract test (Vitest). |
| `npm run check` | `tsc --noEmit` and `vue-tsc` over the Vue components. |
| `npm run lint` / `npm run format` | ESLint, and its fixes. |
| `npm run build:operations` / `npm run build:search` | Build an extension bundle into its `dist/` (the image builds them itself). |
| `npm run generate:invalidation` | Rewrite `source-invalidation.sql` from the collection roles. |
| `npm run setup` | Install the model, migrations, presentation, Flows and dashboard into a running Directus. |
| `npm run brand` | Apply the branding. |

Three suites run against a disposable, licensed Directus on loopback, never
a project holding data:

- `npm run test:csv` (the UTF-8 fix of the CSV import) and
  `npm run test:search` (the course search) on a bare project marked as
  disposable, named by `DIRECTUS_SEARCH_TEST_URL`,
  `DIRECTUS_SEARCH_TEST_TOKEN`, `DIRECTUS_SEARCH_TEST_MARKER_COLLECTION`
  and `DIRECTUS_SEARCH_TEST_MARKER_VALUE`;
- `npm run test:integration` (the public and private reads and every
  `/legacy` file) on a project setup has installed, named by
  `DIRECTUS_INTEGRATION_URL` and `DIRECTUS_INTEGRATION_TOKEN`;
- `npm run test:e2e` (Playwright: the course-history search and the Data
  operations dashboard in Studio) on the same project, named by
  `DIRECTUS_E2E_URL`, `DIRECTUS_E2E_EMAIL`, `DIRECTUS_E2E_PASSWORD` and
  `DIRECTUS_E2E_TOKEN`.

The **Integration** workflow runs all three on `main` and on this
repository's pull requests: it starts the development compose project with
the `DIRECTUS_LICENSE_KEY` secret, marks it, runs the CSV and search
suites, runs setup twice and then the deployment and Studio suites; a
failed Studio run uploads its Playwright traces.

## History

The data was migrated once from the `finki-hub.xlsx` workbook by an
importer that has since been removed, together with the publication of
JSON files to an R2 bucket that Directus replaces. Both remain in the git
history.

## License

This project is licensed under the terms of the MIT license.
