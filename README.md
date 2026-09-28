# FINKI Hub data in Directus

This repository sets up the private Directus project that holds the FINKI
Hub data: courses and their curriculum, staff, rooms, students, the Moodle
course-history snapshot and the enrollment counts derived from it. Editors
change source records in Directus Studio with native forms; native Directus
Flows keep the derived data current on their own; an administrator
publishes the declared public JSON files to the R2 bucket by hand. The
runtime is two services, Directus 12.3.1 (a local image with a UTF-8 fix)
and PostgreSQL 18, with no other long-running service, queue or system
cron.

The TypeScript tooling follows the current FINKI Hub service conventions:
npm, ESM, strict TypeScript, Zod, ESLint with `eslint-config-imperium`,
Vitest and Vue.

Contents:

- [Supported paths](#supported-paths): requirements, fresh setup, the
  one-time workbook import, replacing the Moodle snapshot, exit codes
- [Data model and ownership](#data-model-and-ownership): what the workbook
  fills, what is edited and what is derived
- [Day-to-day operation](#day-to-day-operation): automatic processing,
  enrollment rules, readiness, the dashboard, publishing, Flow edits
- [Access](#access)
- [Course-history search](#course-history-search)
- [Branding](#branding)
- [Backup and restore](#backup-and-restore)
- [Sizing](#sizing)
- [Extending](#extending): the one place each growing set is declared
- [Development and tests](#development-and-tests)

## Supported paths

Three supported paths set a project up and bring data into it:

| Situation | Path | What it does |
| --- | --- | --- |
| New, empty project | `npm run setup` | Installs the data model, its database constraints and source-invalidation triggers, the Studio presentation (sidebar folders, forms, a default table view for every collection editors browse, the **Curriculum by generation** bookmark, one Needs review bookmark per readiness check that declares a review view, and the **Search** bookmark), the private File Library folder **Moodle snapshots (private)**, every managed Flow family (`src/flows/registry.ts`: the history index, the snapshot import, the mapped and legacy enrollment counts, readiness and preparation, publication, rule seeding and automatic processing), the **Data operations** dashboard and the **Data editor** policy. Writes no records, but once it has run the schedule keeps the derived data current on its own. |
| New project, first data from the workbook | `npm run import` | Refuses unless every application collection is empty, runs setup, then imports the workbook once (see [One-time workbook import](#one-time-workbook-import)). |
| Replace the Moodle snapshot | **Import Moodle snapshot** on the **Data operations** dashboard | Replaces every active Moodle user with the rows of an unchanged scraper CSV, after a private backup (see [Replacing the Moodle snapshot](#replacing-the-moodle-snapshot)). |

The import writes only into an empty project and refuses one that already
holds data.

None of them runs by itself: a `docker compose up`, container restart or
recreation installs and changes nothing, because the schema, presets and
Flows live in the PostgreSQL database and the Directus image only serves
them. `npm run setup` and `npm run import` name their target on the
invocation (`DIRECTUS_URL` plus `DIRECTUS_TOKEN` or `DIRECTUS_ADMIN_TOKEN`,
an administrator's static token); neither reads `.env` or falls back to a
default URL. `npm run brand` also writes to a project, but it changes
nothing except the appearance settings and the branding files, and it does
read `.env` (see [Branding](#branding)).

Setup is idempotent and install-once: rerunning it creates only what is
missing. A preset (default view or bookmark), dashboard panel or Flow that
already exists is never changed, whoever created it, so column choices,
filters, panel settings and Flow settings edited in Studio survive every
rerun. Repository Flow definitions are templates with stable ids, not a
source of truth. To take a newer template of a managed Flow, delete that
Flow in Studio and run setup again. If an earlier run was interrupted after
creating a Flow but before wiring it, the command stops and names the Flow
to delete instead of repairing it.

A few things are code-owned and kept in step on every rerun:

- The choices of every enumerated field (their labels and the
  server-enforced rule that only they may be stored) are declared once with
  the field (`src/data-model/*-collections.ts`). When an installed field's
  choices, labels or rule differ, setup rewrites exactly those three meta
  keys (`options`, `display_options`, `validation`, merged: a placeholder or
  any other option stays) and reports the field as `aligned`, while the keys
  Studio owns (note, width, group, sort, conditions) are never sent. Before
  that it reads the field's distinct stored values, and when one of them is
  no longer a declared choice it refuses (exit code 2), names the values and
  changes nothing.
- Every managed Flow family is registered once in `src/flows/registry.ts`;
  setup installs them in one loop and reports `created` and `skipped` per
  family under `flows.families`.
- The **Data editor** policy is kept equal to its derivation from the
  collection roles (see [Access](#access)); a hand edit of its permissions is
  undone by the next setup.
- A Needs review bookmark, default view, dashboard panel or Flow template
  that the code declares and the project lacks is created, so a check or
  panel declared later appears on the next setup.
- A unique or index flag that a Studio edit removed from a declared column
  is restored, and a relation whose alias, sort, deselect action or delete
  rule drifted is realigned. A table or column the model declares that
  Directus does not manage (no Directus meta, as another tool would leave
  it) is refused (exit code 2), never taken over.

### Requirements

- Docker with Compose, Node.js 24 and npm. Every command here was run on
  Node 24. The lint configuration accepts only Node 24 or 26 and the
  extension builds need at least 22.12, so older versions are not
  supported.
- A Directus licence. Core (unlicensed) Directus 12.3.1 allows 3 seats, 25
  collections and 5 active Flows and locks the instance above that; the
  data model alone has more collections than that, and setup installs more
  active Flows. Setup refuses with exit code 2 when Directus rejects a
  collection for its licence limit. Directus reads the key from
  `LICENSE_KEY` in the container's environment, which the checked-in
  `compose.yaml` does not pass: add it through a Compose override file of
  your own, kept outside the repository with your other secrets, for
  example

  ```yaml
  services:
    directus:
      environment:
        LICENSE_KEY: ${LICENSE_KEY:?Set LICENSE_KEY to the Directus licence key}
  ```

  and start the stack with both files (`docker compose -f compose.yaml -f
  <private override> up -d --build`). Compose takes `LICENSE_KEY` from the
  shell that runs it or from the `.env` next to `compose.yaml` (the one
  created from `.env.example` in step 1 of [Fresh setup](#fresh-setup);
  git ignores it), so add a `LICENSE_KEY=` line there or export it, or
  write the key into the private override itself. With the `:?` form above
  Compose refuses to start while the key is unset, instead of starting an
  unlicensed Directus that setup then refuses. The licence is bound to the
  key, the project and `PUBLIC_URL`, and stored encrypted under `SECRET`;
  see [Backup and restore](#backup-and-restore) before moving a project.
  Another project started with the key of an existing one, a test project
  for example, activates the key again as a new project (a restored copy
  with the same `SECRET` refreshes its own licence instead): give a
  disposable test project a licence key meant for it, and never run two
  projects on one key at the same time.

### Fresh setup

1. Create the local Compose configuration, set the administrator's e-mail
   and replace every `change-*` value (the administrator's password and
   static token, a `DIRECTUS_SECRET` of at least 32 bytes and the database
   password). The `STORAGE_PUBLISH_*` values name the R2 bucket publication
   writes to (see [Publishing](#publishing)). Every publication replaces
   the objects in that bucket, and readiness does not compare row counts,
   so an empty or half-filled project publishes empty or short files. Until
   the project holds its complete data, point `STORAGE_PUBLISH_*` at a
   separate scratch bucket, never the bucket the public consumers read.
   `DIRECTUS_URL` there is read only by `npm run brand`:

   ```sh
   cp .env.example .env
   ```

2. Install the dependencies:

   ```sh
   npm ci
   ```

3. Start Directus and PostgreSQL (with your licence override, above) and
   wait until Directus answers:

   ```sh
   docker compose up -d --build
   curl --fail http://localhost:8055/server/ping
   ```

4. Install the model, the Flows and the dashboard into the empty project.
   The command prints its summary as JSON:

   ```sh
   DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=<administrator token> \
     npm run setup
   ```

5. Apply the FINKI Hub appearance with `npm run brand`, then open
   <http://localhost:8055> and sign in with `DIRECTUS_ADMIN_EMAIL` and
   `DIRECTUS_ADMIN_PASSWORD` from `.env`.
6. Attach the **Data editor** policy to the roles of the people who edit
   the data (**Settings → Access Policies**); setup attaches it to no role.

The project is empty: its academic years, curriculum generations, study
programs, courses and the rest are rows you add in Studio (see
[Extending](#extending) for the order). To start from the workbook instead,
run the one-time import (below) in place of step 4.

### One-time workbook import

1. Check the workbook without writing anything (no credentials needed).
   Like the import, the dry run does not read `.env`: it reads the workbook
   named by `WORKBOOK_PATH` on the invocation, else `finki-hub.xlsx`, so both
   commands read the same file:

   ```sh
   WORKBOOK_PATH=finki-hub.xlsx npm run import:dry-run
   ```

   The command runs the import's own check (below) and prints, as JSON,
   the rows the import would write per collection, the count per code of
   the cases that would refuse it (`blockers`), of the rows it would skip
   (`skipped`) and of the warnings (`warnings`), and the count per column
   of the values no column can hold (`unstorable`). It exits with code 3
   and lists every refusing case and value by sheet and row on stderr when
   the import would refuse the workbook, and with code 1 when the workbook
   cannot be read.

2. Run the one-time import against the empty project (steps 1 to 3 of
   [Fresh setup](#fresh-setup) first; the import runs setup itself):

   ```sh
   DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=<administrator token> \
     WORKBOOK_PATH=finki-hub.xlsx npm run import
   ```

3. Continue with steps 5 and 6 of [Fresh setup](#fresh-setup).

The import reads the whole workbook and checks it before it contacts
Directus, exactly as the dry run does, so a workbook it refuses leaves
Directus untouched:

- A missing or unreadable workbook, or a cell that is not of its
  column's kind (a boolean column holding other text), stops with exit
  code 1, naming the file or the column and row.
- Everything the import could not write as the workbook states it stops
  with exit code 3, all of it reported in one run and never by a value:
  each value the column it is written to cannot hold (a string over 255
  characters, an integer out of range, an empty required value), named by
  its sheet, row and column, and each case below, named by its code, sheet
  and rows. The cases are a relationship with more than one candidate (a
  course name two courses carry, a curriculum name matching several
  curriculum rows, a council index two students share, two different 2018
  labels for one course), a row the model cannot hold (a course without a
  name, a pattern that is no Unicode regular expression, a repeated
  council or dean's office row), and every value the published files
  carry that no relational row could hold: credits or availability of a
  generation without its name (`unlinked_generation_values`), two
  `Наставен Кадар` rows for one course (`duplicate_assignment`), a
  curriculum name, 2018 override or 2018 equivalency label that matches no
  curriculum row (`unmatched_curriculum_2023_label`,
  `missing_override_target`, `unmatched_curriculum_2018_label`). Correct
  the workbook and run the import again; the project is still empty.
- Rows no published file ever used are skipped, and the summary counts
  them per kind: a `Наставен Кадар` or `Слушатели` row naming no course
  (`orphan_assignment`, `orphan_pattern`), a pattern of a year the sheet
  does not head (`unknown_academic_year`), and the earlier patterns of a
  course and year, of which the last one applies (`duplicate_pattern`).
- Everything else is imported as the workbook holds it, and what deserves
  a look in Studio is counted under `warnings`. Readiness counts some of
  these again afterwards (a teaching text that names no single staff
  member, an equivalency label that matches no entry, a council index no
  student carries); others only the import counts (curriculum rows no
  course names, `unreferenced_rows`).

It then refuses, before its first write, a project in which any application
collection (every collection the import fills, the relational collections,
the Moodle staging and index collections) holds a record, and prints the
record count of each; the empty schema `npm run setup` creates, including
its coordination status row, is accepted. On an accepted project it:

1. runs exactly what `npm run setup` runs, so importing into an empty project
   equals setup followed by the import;
2. writes the relational rows in dependency order, in batches of 250, each
   reference set to the id Directus answered for the row it names (see
   [What the workbook fills](#what-the-workbook-fills)): the academic years,
   curriculum generations and study programs; the staff, rooms, students,
   Discord channels, dean's office and Moodle users; the courses; the
   curriculum entries with their program states; the course links; the
   enrollment rules; the teaching role rows; the equivalencies with their
   members; the council.

The academic years it writes are the ones the **Слушатели** sheet heads, in
its order (published, the oldest sorting first), with one `legacy_regex`
rule per course and year. The sheet must head its column groups with labels
such as `2025/2026`, newest first, or the import stops before contacting
Directus; a later year is one more column group, placed first. The
curriculum generations and study programs come from the curriculum sheets:
each program column is headed by its program code on the first line (a
second line, such as the duration, and a link are ignored); the generations
with a curriculum sheet and their programs are published, the label-only
2013 generation is not.

It runs no Flow and never publishes.

The import is not one transaction, and its check for an empty project and
its first write are not atomic against another writer: let nobody write to
the project while it runs. If it stops after it started writing rows, it
exits with code 4, and the message says how many planned rows Directus had
confirmed. There is no resume: set up a fresh project (new Compose volumes,
or the backup taken before the import) and import again. When Directus
confirmed no row, the project may still be empty, and the import simply
runs again (it refuses, listing them, if the failed request stored rows
after all).

Publish through **Publish / Public assets (relational)** once readiness
passes (see [Publishing](#publishing)).

There is no update, merge, reconciliation, or ongoing Google Sheets
synchronization mode. After the import, Directus is the source of truth.

### Replacing the Moodle snapshot

A whole Moodle snapshot replaces the active one through the controlled
import, which administrators run from Studio. The scraper's output is used
unchanged: the [`courses-scraper`](https://github.com/finki-hub/courses-scraper)
`profiles.csv` and its 38 headers, with no conversion step and no identity
matching here (snapshot identities are the scraper's business). The native
**Import / Export** sidebar of **Moodle Users** is not supported for
snapshots: it upserts rows by the generated `id`, drops empty cells, turns
the text `null` into NULL, parses JSON-looking text, accepts structurally
malformed rows and replaces nothing atomically.

**The replacement is total.** Every active Moodle user is replaced by the
file's rows, including every edit made to a Moodle user in Studio since the
last import. A private backup of the replaced rows is written first. Course
mappings, history entries, enrollment rules and every other collection are
kept.

1. Run `courses-scraper` normally to produce `profiles.csv`: the 38 headers
   of the scraper contract, in any order, and no `id` column.
2. Upload `profiles.csv` into the **File Library** folder **Moodle snapshots
   (private)**, which `npm run setup` creates. It stays a private file in the
   local storage location. The import refuses a CSV outside that folder, so
   one permission filter on the folder keeps every snapshot file and backup
   away from any role that may read files.
3. Run **Import Moodle snapshot** on the **Data operations** dashboard (or
   the Flow **Data / Import Moodle snapshot** from the sidebar of the
   hidden **Data Operations** singleton, `/admin/content/data_operations`).
   Choose the file in **Private CSV file** (an item picker that lists the
   files of that folder; a REST caller may send the file id) and switch on
   **Replace the whole active Moodle snapshot**. Switch on **Allow an empty
   snapshot** only to remove every Moodle user on purpose.

The Flow first stages the file into the hidden staging collection in one
transaction and answers only once it committed. The file must be strict CSV
with exactly the 38 field names; an empty line between rows is refused,
empty lines at the end are ignored. Every value is kept exactly as written,
`Name` is required, and a populated `ID_old` or `ID_new` must be a positive
id that is unique within its own column. A history line longer than 2,048
bytes is staged unchanged and reported, because the history index will
refuse that user until the line is shortened at the source. The Flow then
writes a private backup CSV of the current Moodle users
(`moodle-users-backup-<time>.csv` in the same private folder) and verifies
it. Finally it replaces the active users in one database transaction under
the coordinator's exclusive claim. A refused file or a failed step changes
no active row. The history memberships are cleared, and the history index,
the enrollment counts and publication become pending: the schedule rebuilds
the index and then the counts on its own (see
[Automatic processing](#automatic-processing)). Search reads the new raw
histories at once, while the counts are still pending. To restore the
previous snapshot, run the same Flow with the backup file.

Backups accumulate in the private folder; deleting old ones is a manual File
Library task. A backup whose verification failed stays there as a file the
import did not record. The Flow runs synchronously: a file large enough to
outlast Node's 300 second request timeout loses the answer, not the run
(read the state from the status below). If Directus dies during an import,
the snapshot state stays `importing` or `validating` (readiness blocks with
`snapshot_import_running`) until the next import takes it over, which it
does only once `IMPORT_TIMEOUT` plus 60 seconds have passed since the dead
run started.

The import is bounded by `IMPORT_TIMEOUT` (15 minutes in `compose.yaml`) and
by `FINKI_HUB_SNAPSHOT_MAX_BYTES` (256 MiB unless set in the Directus
container's environment, which the checked-in Compose file does not pass).
For administrators, `GET /finki-hub-data-operations/snapshot` reports the
import state, the staged and active row counts with their fingerprints, the
backup, the last error, the snapshot the last promotion made active, and
whether the active rows still equal it (`activeMatchesPromotion`, false
after an edit outside this workflow, whatever later imports did). A failed
run logs its code and the database object involved, never a value, to the
Directus log.

### Exit codes

| Code | `npm run setup` / `npm run import` |
| --- | --- |
| 0 | Done. |
| 1 | Failed before any row was written: a workbook that cannot be read (a missing file names its path; nothing sent to Directus), a target that answers an error (a wrong token answers `401` with `INVALID_CREDENTIALS`; name a static administrator token of that project), or an unexpected error. After an unexpected error the schema or Flows may be partly installed, and rerunning is safe. |
| 2 | Refused: no explicit target, an unknown argument, a populated project offered to the import (with its record counts), existing definitions the model cannot carry (including a table or column Directus does not manage), a licence that caps the collections, a half-installed Flow, or a Directus without the data-operations bundle. No record was written. |
| 3 | Import only: the workbook holds values no column can hold or cases the import cannot write as it states them, listed by column or code, sheet and row. Nothing was sent to Directus (the dry run answers the same); correct the workbook and run again. |
| 4 | Import only: the import stopped after it began writing rows. The message says how many planned rows Directus had confirmed; set up a fresh project and import again (see above). |

A populated project is never imported into: import into a new, empty
project instead (fresh Compose volumes and `npm run setup`, or the import
alone), or restore the backup taken before the first import and import
again.

Messages name counts, codes, ids, paths, sheets, rows, columns and
collections. A refused boolean, integer or year-header cell is quoted so it
can be found; no other workbook or snapshot value is printed.

### Compose, image and ports

Compose builds a local image from official Directus 12.3.1 with a one-line
UTF-8 CSV decoding fix. The stock importer can corrupt multibyte characters
that cross file read boundaries; the patch decodes the stream before it
reaches the CSV parser. No image registry or publishing step is needed. When
deliberately upgrading the base version in `directus/Dockerfile` (and the
local image tag in Compose), review whether the patch is still necessary.
The build stops if the expected patch target has changed, rather than
silently leaving the fix unapplied. `npm run test:csv` checks the fix on a
disposable project (see [Development and tests](#development-and-tests)).

The checked-in `compose.yaml` runs only these two services and publishes
Directus on `127.0.0.1` only (`DIRECTUS_PORT`, default 8055). Exposing it on
a network, the licence key and any other deployment-specific setting belong
in a Compose override file of your own, outside the repository. The
extensions are mounted read-only from `directus/extensions`, whose compiled
bundles are committed, so a checkout runs without a build step.

`docker compose down -v` deletes the database and the uploads volume
permanently and must not be used against a deployment containing data.

## Data model and ownership

Every collection of the model is private. Relationships are native Directus
relations (many-to-one, one-to-many, many-to-many through a junction) with
readable display templates, keyed by generated ids, never by course names.

### What the workbook fills

Every independent dataset in the workbook is imported. Cached spreadsheet
formula results are not treated as source data. A tabular sheet is read one
row per non-empty row below its header; the two index sheets one row per
student of each index and name column pair, headed by its source group;
`Дискорд` one row per channel pair of each semester's column pair; and
`Слушатели` only its explicit patterns, one per course and year whose
pattern cell holds a value rather than a formula. The import writes the
relational rows straight from them:

| Sheet | Relational rows |
| --- | --- |
| `Предмети (Export)` | `courses` (name, tags, `professors_override`); the 2023 and 2018 name, credits and availability of each course become its `course_curricula` links |
| `Кадар (Export)` | `staff` |
| `Простории (Export)` | `rooms` |
| `Индекси - Година`, `Индекси - Други` | `students` |
| `Предмети - 2023`, `Предмети - 2018` | `curriculum_generations`, `study_programs` (from the program column headers) and `curriculum_entries` with their `curriculum_entry_program_states`, one entry per sheet row, orphans and duplicates included |
| `Еквиваленции` | `course_equivalencies`, linked to the course its 2023 label names, each filled label a `course_equivalency_members` row |
| `Наставен Кадар` | `teaching_assignments` role rows (course, staff or label, role, order) |
| `Слушатели` | `academic_years` from its year column groups, and one `course_enrollment_rules` row per course and year, whose pattern is the sheet's pattern where one exists (see [legacy rules](#enrollment-counts-from-legacy-rules)) |
| `Дискорд` | `discord_channels`, one row per channel pair |
| `ФСС` | `student_council`, linked to the student of its index |
| `Деканат` | `deans_office` |
| `Courses` | `moodle_users`, the active Moodle snapshot; the schedule builds its history index |

Spreadsheet booleans and numbers become native Directus/PostgreSQL booleans
and integers. Long text and URLs use PostgreSQL text fields. Student rows are
read from the two independent index sheets rather than the formula export;
`source_group` preserves the cohort/legacy/external grouping. Duplicate
student indices are retained, and no person is merged by name.

`moodle_users` contains names, email addresses, profile details, and course
histories. Its field keys match the current `courses-scraper` `profiles.csv`
headers, so every later snapshot is imported without changing the scraper
output. The workbook's older `ID`, `Profile`, and `#` columns are imported as
`ID_new`, `Profile_new`, and `Courses Count`; the next scraper snapshot also
populates the old-instance and timezone fields that the workbook does not
contain.

Values the import cannot relate unambiguously but can keep (a teaching text
that names no single staff member, an equivalency label that matches no
entry, a council index that matches no student) are kept as literal labels
and counted by readiness. Nothing is guessed: an ambiguity, and every value
the published files carry that no relational row could hold, refuses the
import instead (exit code 3). Only rows no published file ever used are
left out, and the import counts them (see
[One-time workbook import](#one-time-workbook-import)).

### Editable, derived and bookkeeping collections

Each collection has one role, declared once in
`directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.ts`.
The role decides which calculations an edit marks pending, whether the
database guards the table and what the **Data editor** policy grants:

- **Editable sources** (for example `courses`, `curriculum_entries`,
  `course_curricula`, `teaching_assignments`, `staff`, `rooms`,
  `students`, `student_council`, `course_equivalencies` and their members,
  `moodle_course_entries`, `moodle_course_mappings`,
  `course_enrollment_rules`): edited in Studio. Every statement on one marks
  the calculations that read it, and publication, pending inside its own
  transaction.
- **Key sources** (`academic_years`, `curriculum_generations`,
  `study_programs`): editable sources by their role, like the collections
  above, whose `published` flag, key text, `sort` and parent decide the
  public keys. Which fields those are is not part of the role: it is
  derived from the key-source declarations in
  `directus/extensions/directus-extension-data-operations/src/exports/key-sources.ts`
  (see [A key or a new published file](#a-key-or-a-new-published-file)),
  which decide both the fields the **Data editor** policy withholds, so
  only administrators change them, and the database guard that keeps the
  key text of a published row.
- **`moodle_users`**: the active snapshot. Replaced as a whole by the
  snapshot import; an administrator may still correct a row in Studio, which
  readiness reports (`active_snapshot_edited`) and the next import
  replaces.
- **Derived** (`moodle_history_memberships`, the history index;
  `course_enrollments`, the counts): written only by their own runs. The
  database refuses every other write and names the remedy, so edit the
  sources instead. The course form still shows edit and delete buttons on
  its derived **Enrollments** rows; the guard refuses them.
- **Candidate, staging and status** (`data_operation_results`,
  `moodle_import_rows`, `data_operations`): bookkeeping of the running
  operations, never edited by hand. The **Data Operations** singleton keeps
  its bookkeeping (source revision, last error) across everything, and
  setup never resets it.

A course holds only what `courses.json` publishes from it directly (name,
tags, `professors_override`); its curriculum lives in its links, its staff
in its role rows, and a council member is named by the linked student (its
index labels an unlinked one).

### Academic years, curriculum generations and study programs

These are rows administrators manage in Studio, never a code list:

- `academic_years` (`label` such as `2025/2026`, `sort`, `published`).
- `curriculum_generations` (`code` such as `2023`, `label`,
  `has_curriculum`, false for a label-only generation, `published`,
  `sort`).
- `study_programs`, one row per program per generation (`generation`,
  `code` such as `kn`, `name`, `description`, `published`, `sort`).

A new row never adds a public key by itself: a year, generation or program
reaches `courses.json` only once an administrator sets its `published` flag
(a program also needs its generation published). The database keeps the key
text of a published row: changing the label of a published year or the code
of a published generation or program answers 400 `INVALID_FOREIGN_KEY`;
unpublish the row first (one write may unpublish and rename). Deleting a
generation or program that entries, links, members or program states still
reference is refused by the database; Directus 12.3.1 answers that delete
with HTTP 500 naming the foreign key, not a 400, so move or remove the
referencing rows first.

Curriculum entries are one collection for every generation. The
**Curriculum by generation** bookmark on **Curriculum Entries** lists them
generation first; narrow it to one generation with Studio's native filter on
**Generation**, so a new generation needs no bookmark and no setup rerun.

### Forms and relationships

A course is the entry point: its form shows its curriculum links and
equivalency members, its staff assignments and `professors_override`, the
Moodle history entries mapped to it per academic year, and its enrollment
rules and derived counts. A history entry's form shows its exact label and
review state (`needs_mapping`, `mapped`, `ignored`, with a reason), its
mappings, and the users carrying it (the derived index, read-only).

- The curriculum entry picker of a course link and the program picker of an
  entry's program states offer only rows of the chosen generation (the
  program states list stays locked until the entry has a generation). These
  filters are Studio conveniences; the database guards are the boundary and
  refuse a link, state or member whose generation differs.
- Rows added in a related list are shown as placeholders until the parent
  is saved (Directus behaviour).
- **Professors** of `courses.json` are `professors_override` when set, else
  the course's professor assignments in order; see [Publishing](#publishing).

## Day-to-day operation

### Automatic processing

The history index and the enrollment counts refresh on their own; nobody
has to press a button after an edit. `npm run setup` installs these Flows
for it:

- **Data / Process pending** runs on a native Directus schedule every 15
  seconds (cron `*/15 * * * * *`; the seconds field comes first, so
  `0 */15 * * * *` would mean every 15 minutes). Each tick asks the
  coordinator for the first pending calculation: the Moodle history index
  first, the enrollment counts after it, never publication, which stays
  for the publish Flow. When nothing is pending, when another run holds the
  claim, when a long source transaction holds the status row for more than
  2 seconds, or when the pending work failed at its current inputs, the
  tick ends at once. It reads the coordination status row and the Flow
  graph, never a collection. When it claims, it runs exactly one domain,
  through **Data / Refresh history index** (every history page in turn
  through **Data / Index Moodle histories** and **Data / Index history
  page**, then the completion) or **Data / Count enrollments** (one plan of
  every rule family, each family in turn through **Data / Run enrollment
  family** and the runner Flow its rule mode declares, then one completion
  that installs every pair). The next tick takes the next domain.
- **Data / Mark pending** (the **Recalculate** panel of the dashboard) is a
  manual Flow on the hidden **Data Operations** singleton for
  administrators. It marks the chosen domains pending (the history index
  and the enrollment counts when none is chosen) and answers the status.
  It runs nothing itself: the schedule picks the work up at its next tick.
  It is also the explicit retry of a failed run.
- **Data / Count enrollments** and **Data / Refresh history index** run
  under a claim their caller holds and never claim themselves.

Every edit of a source collection marks its domains inside the edit's own
database transaction (the statement triggers of `npm run setup`), so a
rolled-back edit marks nothing and a committed one is never missed, whether
it came from Studio, the REST API, a native CSV import or SQL. A Moodle user
marks the history index, the counts and publication; entries, mappings,
rules and academic years mark the counts and publication; every other
source collection marks publication. The mark covers the whole domain, so a mapping or rule moved to
another course or year, or deleted, changes both the old and the new pair; a
deleted mapping leaves its rule, whose pair is then counted as 0. Deleting an
entry or editing its label by hand (the label belongs to the index) marks
the history index too. Toggling an academic year's `published` flag marks
the counts too, because a statement trigger cannot tell one column of that
table from another; marking publication only for the tables a published
file reads is an open decision. Each calculation also keeps the revision of
the last statement that touched its inputs (`history_index_input_revision`,
`enrollments_input_revision`; a Moodle user touches both, an entry, mapping,
rule or academic year the counts): an edit of a room, staff member, course
or any other publication-only collection never discards a running
calculation or retries a failed one. `source_revision` counts statements,
not edits: deleting a parent row fires the trigger once per table its
deletion cascades into.

**Completion is not instant.** A change reaches `course_enrollments` within
one interval plus the run: on a small synthetic project, 13 to 15 seconds
after an edit, of which the count run took about 0.2 seconds (7.3 seconds
with 450 mapped rules). An edit of a Moodle history needs two ticks, the
index and then the counts. Nothing is pushed to an open page: refresh it.
Fifty edits between two ticks cost one run. Larger projects take longer
(see [Sizing](#sizing)).

When a run fails (for example a legacy pattern that does not compile), the
installed counts stay, the domain stays pending, and the status keeps the
failure's code and message (ids only). The schedule does not retry it on
later ticks: an edit of a collection the calculation reads, **Data / Mark
pending** or a change to the Flow graph lets the next tick run it again; an
edit that only marks publication does not, and time alone never does. A
run that such an edit or a Flow change overtakes is discarded instead
(`SOURCE_CHANGED`, `FINGERPRINT_CHANGED`) and runs again at the next tick;
a history page left over after that stops at its claim check before it
reads any Moodle user. Work left pending by a Directus restart is
processed by the restarted process's schedule. A restart in the middle of
a run leaves a claim that stops heartbeating; once its last heartbeat is
60 seconds old it is released as `CLAIM_INTERRUPTED`, and the next tick
runs the domain again, with no button. If that rerun is interrupted too, at
the same inputs and Flow graph, it is released as `CLAIM_ABANDONED`, a
failure that waits for **Data / Mark pending**, so a run that brings the
process down stops after one automatic retry. An abandoned publication
claim is always `CLAIM_ABANDONED`. The heartbeat **Publish / One file**
sends right before each upload leases the publication claim for 20
minutes (the status shows a negative heartbeat age meanwhile), and
recording the file's outcome ends the lease: Directus's S3 driver can still
be writing an object that long after the upload started (a replacement
makes three S3 calls before the object is written, each tried three times
with a 5 second connection and a 120 second socket timeout), so recovery
never releases a claim whose upload could later overwrite a newer
publication. A Directus that dies in the middle of an upload therefore
holds every claim for up to 21 minutes. Raising the publish location's
S3 timeouts (`STORAGE_PUBLISH_SOCKET_TIMEOUT`,
`STORAGE_PUBLISH_CONNECTION_TIMEOUT`) needs a longer lease
(`publicationUploadLeaseMs` in `coordination/state.ts`).

Two races end in a PostgreSQL deadlock, which aborts one side: creating an
entry label through the API while the index writer inserts the same label,
and deleting a course (or another row whose deletion cascades into
`course_enrollments`) while an enrollment run installs its counts. Directus
retries its own aborted item write. The coordinator runs each transaction of
a claimed run (planning, staging or indexing a page, completing) again after
a deadlock (`40P01`) or a serialization failure (`40001`), and never after
any other error: at most three attempts, 50-100 ms and then 100-200 ms apart,
each checking the claim, its revision and the Flow graph again, so a claim
lost or overtaken meanwhile refuses as before. The claim adds up the retries
of every transaction of its run (`claim_retries`); the completion's answer
and the status carry the total, as `lastRun.retries` for a completed run and
`lastError.retries` for a released one, and the dashboard names them. An
index page that lost finds the label the API created and goes on. An install
that lost to a delete meets the committed delete when it runs again: the
delete changed its inputs, so the run is overtaken (`SOURCE_CHANGED`, not a
failure) and the next tick counts again, as after any edit during a run (at
full size a whole run, see [Sizing](#sizing)). A run whose three attempts
all conflict fails with the database's error.

The coordinator fingerprints two Flow graphs. A Flow belongs to the
**calculation graph** when one of its coordinator steps claims a
calculation domain or `next_calculation`, or plans, stages or indexes
pages; to the **publication graph** when one claims `publication`; and in
either case so does every Flow it reaches through a Trigger Flow step. A
claim whose domain (or a step whose action) is templated or unknown counts
for both. Flows whose coordinator steps only mark, read the status,
heartbeat, complete or fail (**Data / Mark pending** and its dialog) belong
to neither. A change to a Flow of a graph (its trigger, an operation's
type, options or edges) makes the domains of that graph pending: a
calculation change marks both calculations and publication (the
publication fingerprint includes the calculation fingerprint), a change to
the publish Flows marks only publication, and rewording the Mark pending
dialog marks nothing. A name, description, icon, position or status never
counts. The status reports both as `fingerprints.current.calculation` and
`fingerprints.current.publication`, beside the accepted ones of the last
completed calculation and publication.

`GET /finki-hub-data-operations/status` (administrators) reports each
domain under `domains` with `state` (`current`, `pending`, `running` or
`failed`), `current`, and `waitingFor`, the pending domains it runs after.
A failed or interrupted history run leaves `history_index` not current:
its index is stale until a run completes. `lastError` keeps the last
failure with its code, message and source revision after later successes;
its `blocking` flag says whether it still holds its domain back.
`revisions.inputs` shows each calculation's input revision. Every status
read also summarizes the history index with whole-table counts.

### Enrollment counts from explicit mappings

A history entry counts for a course and academic year through a mapping
(`moodle_course_mappings`: entry, course, academic year; an entry may have
several). A pair is counted when its enrollment rule has the mode
`mapped_entries`. `npm run setup` installs three operation-triggered Flow
templates for them:

- **Data / Count mapped enrollments** counts one pair. It takes
  `{course, academic_year, revision, claim}`, refreshes the enrollment claim,
  reads the number of distinct Moodle users that have a history entry mapped
  to that course and academic year in one mapping row, and returns
  `{course, academic_year, count, revision}`. A user who has two matching
  entries counts once. When nothing matches, the count is a real zero. On a
  failure the Flow returns `{ok: false, stage, code, message}` and never
  a zero. It writes nothing.
- **Data / Count mapped enrollment page** takes one planned mapped page
  (a mapped page of `plan_pages` with source `enrollments`, or a page of
  source `rules`, which the coordinator plans only while every rule is
  `mapped_entries`, plus the claim and its revision). It first reads the plan
  that the coordinator stored for the current claim. The claim must be that
  enrollments claim at that revision, and the page's kind, range and rule
  count must be the planned ones; anything else is refused with
  `PAGE_PLAN_MISMATCH`. It then reads the `mapped_entries` rules of the
  planned range and checks that it read every one of them. It counts each
  pair with the Flow above, one pair at a time, and stages all counts of
  the page, zeros included, in one coordinator `stage_page` call. If any
  pair fails, it stages nothing.
- **Data / Count mapped enrollment pages** runs the `mapped_entries` family
  of an enrollments plan (`{claim, kind, pages, revision, runner}`): every
  mapped page in turn through the page Flow above, then a check that each
  staged one row per planned rule. It answers `{ok: true, pages, staged}`;
  on any failure it fails the claim (`MAPPED_COUNT_FAILED`) and answers
  `{ok: false, stage, code, message}`.

Only the enrollment claim's completion writes `course_enrollments`, and it
replaces every row at the claimed revision, so one claim must stage every
rule family (see [Rule modes](#rule-modes)). **Data / Count enrollments** is
the Flow that does so under the claim the schedule takes. The coordinator
refuses `plan_pages` with source `rules` under an enrollments claim while
any rule is not `mapped_entries`, and source `history` under any claim but
a history index claim (`DOMAIN_MISMATCH`), so an enrollments claim is
never completed from a plan that leaves a family out.
All three templates are part of the calculation fingerprint (the pair and
page Flows through their coordinator steps, the family runner as a declared
root), so an edit to any of them in Studio marks every calculation pending
again. The count query filters with
the path `history_memberships.entry.mappings` and puts the course and the
year side by side in that path. Keep that shape when you edit the query in Studio:
Directus ignores a `_some` block that holds two conditions, and two separate
`_some` blocks can match the course of one mapping with the year of
another. The same holds for every relational filter, including a role's
permission filters.

A mapping whose course and year has no enrollment rule is not counted
(readiness warns with `mapping_without_rule`); **Add enrollment rules**
creates the missing rules (see [Extending](#an-academic-year-and-its-rules)).

### Enrollment counts from legacy rules

The one-time import seeds every course and year of the workbook as a
`legacy_regex` rule whose pattern is recorded literally: the last pattern
the `Слушатели` sheet names for that course and year, else
`<course name>-<year>`. Renaming a course later changes no rule. The
pattern stays editable in **Course Enrollment Rules**; no Flow and no
extension interprets it except the count script below, which applies it
as `new RegExp(pattern, 'u')` over the whole raw `Courses` history, tested
once per user. Names are not escaped, so a
pattern may cross line boundaries, and a pattern that does not compile
(for example the default of a course named `C++ Course`) fails the run.
Switch a rule to `mapped_entries` in Studio once its entries are mapped and
the mapped users equal the ones its pattern matched; keep `legacy_regex`
where an expression needs several entries at once.

`npm run setup` installs three operation-triggered templates:

- **Data / Count legacy enrollments** runs the `legacy_regex` family of an
  enrollments plan (`{claim, kind, pages, revision, runner}`; it reads only
  the claim). It reads the plan the
  caller stored with `plan_pages` source `enrollments`, runs the two Flows
  below serially for every planned legacy page and zero page, checks every
  answer, and answers `{ok: true, legacyPages, staged, zeroPages, pairs,
  counted, zeros}`. It never plans and never completes. Any failure fails
  the claim (`LEGACY_COUNT_FAILED`), so its candidates are discarded and the
  installed counts stay, and answers `{ok: false, stage, code, message}`
  naming the first failed page.
- **Data / Count legacy rules page** counts one legacy page: at most 250
  Moodle users (only `id` and `Courses` are read) against at most 500
  legacy rules (`id`, `course`, `academic_year`, `pattern`). It checks the
  page against the stored plan, validates types, counts and the byte sizes
  of the histories and of the patterns, compiles every pattern first, and
  stages only the nonzero partial counts. When any step fails it fails the
  claim at once, so every later page of the run refuses without reading a
  history or compiling a pattern: a pathological pattern costs one
  timeout, not one per history page.
- **Data / Fill legacy rule zeros** runs once per legacy rule page after all
  of its legacy pages. It reads the native `sum(count)` grouped by course
  and year over this claim's candidates of exactly those pages (never
  another claim's, a mapped page's or its own earlier rows) and stages an
  explicit zero for every legacy pair no page counted. Like the page Flow,
  it fails the claim at once when any step fails. The completion sums the
  staged rows and never fills zeros itself.

`plan_pages` with source `enrollments` plans every rule family in one plan
of an enrollments claim: the mapped pages first, then per legacy rule page
every history page and its zero page. Every page must be staged before
`complete` accepts the claim, so a run that skips a family is refused with
`PAGES_MISSING` and deletes nothing. History pages hold at most 250 users
and 800,000 UTF-8 bytes of `Courses`; legacy rule pages hold at most 500
rules and 1,000,000 UTF-8 bytes of pattern text, with no cap on a single
pattern's length. Run Script copies the whole data chain into an isolate
of 32 MB (`FLOWS_RUN_SCRIPT_MAX_MEMORY`) and stops it after 10 seconds
(`FLOWS_RUN_SCRIPT_TIMEOUT`). On Directus 12.3.1 the isolate is disposed
at about 16 MB of string storage, and a text with any non-Latin-1
character costs two bytes per character there. The time of a page grows
with its rules times its bytes: on the largest page, literal and
cross-line patterns take 0.1 to 0.2 seconds and whole-text line walks
such as `^(?:.*\n)*...` about 3.3 seconds, a third of the timeout. A
single history or pattern over its budget refuses the plan
(`PAGE_OVER_BUDGET`, naming the user or rule id and the sizes only). A
pathological pattern runs into the Run Script timeout and fails the run
visibly. Neither limit is raised automatically.

### Rule modes

The rule modes (today `mapped_entries` and `legacy_regex`) are declared
once, in
`directus/extensions/directus-extension-data-operations/src/rule-modes.ts`:
each with its Studio label, what it counts, whether it reads `pattern`, how
its rules are planned (plain rule ranges, or rule pages crossed with history
pages plus a zero page each), its page kinds and the Flow that runs its
whole family. The `mode` field's choices and notes, the enrollments planner,
the refusal of an undeclared mode, the `rules` plan check, the rule filters
and page kinds of each family's Flows and the calculation fingerprint all
read that declaration. The vocabulary stays closed: a rule of any other mode
refuses the whole plan (`UNKNOWN_RULE_MODE`).

`plan_pages` with source `enrollments` answers
`{families: [{kind, runnerFlowId, pages}], total}`, one family per mode that
has rules. **Data / Count enrollments** hands the families in turn to
**Data / Run enrollment family**, which refreshes the claim and runs the
family through the runner Flow the plan names. That Trigger Flow step's
target is the template `{{ $trigger.runner }}` (Directus 12.3.1 renders it
like any other option); Studio shows the template text in its Flow picker,
and it must stay as it is. No dispatcher step names a mode, so adding or
retiring one never edits an installed Flow (a new mode brings its own Flow
family), and a mode that no rule uses is not planned at all. Once every
rule is `mapped_entries`, the legacy Flows do not run and the history byte
budget no longer applies. A family's runner is a declared root of the
calculation fingerprint, because the fingerprint cannot follow a templated
Flow id.

### Readiness and Needs review views

Every issue readiness reports is one entry of the readiness-check registry
(`directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.ts`):
its code, severity (`blocker` or `warning`), where its count comes from (a
bounded native aggregate, a check counted in code, the coordinator status or
the snapshot status), the files it gates, an optional Needs review view,
whether its records each carry a curriculum `generation` column (so one view
shows and filters by it, never one view per generation row), and a
description. `ready` is true exactly when every blocker counts zero;
blockers hold back publication, warnings nothing. The registry is code, not
rows, so no Studio edit can turn a blocker into a warning. Readiness
answers counts, codes and links, never a record.

Today's blockers: `history_index_*` and `enrollments_*` (`pending`,
`running`, `failed`, from the coordinator status),
`snapshot_import_running`, `snapshot_import_failed`,
`academic_year_unsorted` (a published year
without a sort, which has no place among the year keys),
`academic_year_sort_shared` (two published years with one sort, whose keys
have no newest-first order), `curriculum_generation_unsorted` and
`curriculum_generation_sort_shared` (the same for the published generations
with a curriculum and their blocks), `study_program_unsorted` and
`study_program_sort_shared` (the same for the published programs of one
generation and their state keys), `enrollment_count_missing` (a course and
published year without a count row), `enrollment_rule_missing` (without a
rule, so it is never counted), `assignment_role_missing`,
`assignment_unresolved` (a published assignment with neither a staff member
nor a display label). Today's warnings:
`assignment_review_label` (an unresolved imported label published as text),
`assignment_order_ambiguous` (two rows of one course and role at one
position; the id decides their order), `mapping_without_rule` (mappings
nothing counts), `mapped_entry_awaiting_review`, `entry_needs_mapping`
(Moodle lines nobody mapped, administrative ones included),
`equivalency_without_course`, `equivalency_entry_unresolved` (an
equivalency with a member label of a generation with a curriculum linked
to no entry of that generation), `council_member_unresolved` (a council
membership linked to no student), `snapshot_staged`,
`active_snapshot_edited` and `snapshot_never_promoted`.

A value of the workbook that the relational rows could not publish as it
stands (a curriculum name that matches no entry, credits or availability
without a name, two teaching rows of one course) never reaches readiness:
the import refuses the workbook until it is corrected (see
[One-time workbook import](#one-time-workbook-import)), so the first
publication never loses or changes text silently.

Unmapped Moodle lines only warn: map an entry, mark it `ignored` with a
reason, or leave it counted by a reviewed legacy rule; administrative lines
need no course.

Every registry entry that declares a review view gets one shared Studio
bookmark on the collection of its records, and the **Readiness** panel of
the dashboard links the check to that bookmark. `npm run setup` creates the
bookmarks that are missing and never changes one that exists, so a check
declared later gets its view on the next setup, and a Studio edit of a view
is kept. The views are generated from `exports/review-views.ts` and
`exports/key-order.ts` of the data-operations extension; today:

| Bookmark | Collection | Check | Lists |
| --- | --- | --- | --- |
| **Needs mapping** | `moodle_course_entries` | `entry_needs_mapping` | entries still `needs_mapping` without a mapping |
| **Mapped entries awaiting review** | `moodle_course_entries` | `mapped_entry_awaiting_review` | entries still `needs_mapping` with a mapping, and its course and year |
| **Equivalency labels without an entry** | `course_equivalency_members` | `equivalency_entry_unresolved` | member labels of a generation with a curriculum and no entry |
| **Equivalencies without a course** | `course_equivalencies` | `equivalency_without_course` | equivalencies without a course, with their member generations and labels |
| **Assignments without staff or label**, **Assignments shown by their label only**, **Assignments without a known role** | `teaching_assignments` | `assignment_unresolved`, `assignment_review_label`, `assignment_role_missing` | the published rows each check counts (a professor row that `professors_override` replaces counts nowhere) |
| **Council members without a student** | `student_council` | `council_member_unresolved` | memberships without a student |
| **Published academic years / curriculum generations / study programs without a sort** | the key source's collection | `academic_year_unsorted` and the like | published rows without a position; a program shows its generation and name |

The checks no plain filter can list (a missing row, a duplicate) link
their collection page instead: today `enrollment_count_missing`,
`enrollment_rule_missing`, `mapping_without_rule`, the three
`*_sort_shared` blockers and `assignment_order_ambiguous`.

Curriculum views show the generation and filter through the
`curriculum_generations` relation, so a new generation's rows appear in
the existing views. A view filters with plain field and relational paths
(never `_some`/`_none`) and with `_empty`/`_nempty` for text (the REST API
refuses an empty string as a filter value); Studio runs it as the viewer,
so the viewer's permissions apply. Each view lists exactly the records its
check counts.

Keep a view's bookmark name when editing it. Setup recognises a view by
its collection and name: after a rename, the next `npm run setup` creates
the declared bookmark again beside the renamed one, and the Readiness
panel links the declared name.

### The Data operations dashboard

`npm run setup` installs one Insights dashboard, **Data operations**, with
its default panels, once (a rerun creates a missing panel and never
overwrites an edited one):

- **Run operation** panels for Publish (**Publish / Public assets
  (relational)**), Recalculate (**Data / Mark pending**), Import Moodle
  snapshot (**Data / Import Moodle snapshot**) and Add enrollment rules
  (**Data / Add enrollment rules**). A panel shows its Flow's own
  confirmation text and dialog fields (the snapshot's private CSV through
  an item picker of the private folder's files) and posts them to the native
  `POST /flows/trigger/:id`. Run is disabled while any data operation holds
  the coordinator's claim and while a run started from a panel of the page
  is in flight, and waits (saying why) while the data status cannot be
  read. Every Run opens the dialog empty, so each replacement or
  publication is confirmed again; a refusal shows its code and message
  with a **Retry** that reopens the same Flow's dialog with the failed
  run's inputs, less its checkboxes (acknowledgements such as "Replace the
  whole active Moodle snapshot" are ticked again for every run). **Edit
  Flow** opens the Flow's configuration.
- **Data status** panels (**Calculations and published files**,
  **Readiness**, **Published keys**), read from `GET /finki-hub-data-status`
  and `GET /finki-hub-data-status/readiness`: every coordination domain
  (idle, pending, running, failed; Publication partial when a failed
  publication uploaded some declared files), every declared public file
  with its last outcome, code, revision and size (the last publication's
  revision comes from these entries), the last run and the last run of each
  scheduled Flow within the past 60 minutes; every readiness check with its
  count and one link to its records (its Needs review bookmark when it has
  one); and the academic years, curriculum generations and study programs
  whose `published` flags decide the public keys, each linked to its form.
  The lists come from the declarations and the status, never from a fixed
  set. The panels poll only while work is in flight (a claim, a running
  domain or a pending calculation) or a run of the page is running: a run
  started in another tab shows at the next such poll or when the page is
  refreshed.

**Add enrollment rules** creates the missing `mapped_entries` rules of an
academic year (every course), a course (every year) or one pair, in batches
of at most 250; see [Extending](#an-academic-year-and-its-rules). A run that
fails in a later batch keeps the batches it created; run it again to add
the rest.

To put another operation on the dashboard, see
[A dashboard action](#a-dashboard-action).

### Publishing

Publication is manual and administrator-only: nothing is published
automatically, and nothing becomes public except through a declared
export definition (see [Extending](#a-key-or-a-new-published-file)).

**Every publication replaces the objects the public consumers read.** The
publish location is the live bucket once `STORAGE_PUBLISH_*` names it, and
each run overwrites every declared file there. Readiness checks what the
rows hold, not how many there are: an empty or half-filled project reports
ready, and one run then replaces every live file with an empty or short
list. Keep `STORAGE_PUBLISH_*` on a separate scratch bucket until the
project holds its complete data. Switch to the live bucket only for an
authorized cutover, after taking a snapshot of the current public objects
(a separate step against the bucket, see
[Backup and restore](#backup-and-restore)).

Today's declared files are `courses.json`, `rooms.json`, `staff.json` and
`students.json`, with the key allowlists, omission rules, ordering and
string representations the public consumers already read. Configure the
`STORAGE_PUBLISH_*` variables shown in `.env.example`: for Cloudflare R2,
the account S3 endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`),
region `auto`, the existing bucket name, and an Object Read & Write token's
Access Key ID and Secret Access Key (a token for the scratch bucket until
the cutover). The files are written through Directus's `publish` storage
location.

`npm run setup` installs, once under stable ids (a Studio edit of any of
them survives every later setup):

- **Data / Validate readiness**, a manual Flow on **Data Operations**
  (administrators), answers `{ready, revision, blockers, warnings,
  issueCounts, links, reviews, blockedFiles}`: a count for every registered
  code, the Studio page and Needs review bookmark of each positive one and
  the files the blockers hold back, never a name or a row.
- **Publish / Prepare public assets**, a dry preparation: readiness, then
  every file read, serialized and validated, then the source revision
  again. It answers `{revision, files: [{filename, rows, bytes, sha256}],
  warnings, durationMs}` and uploads nothing. It refuses with
  `EXPORT_NOT_READY` (409, before any file is read) while readiness has a
  blocker, and with `EXPORT_UNSTABLE_PREPARATION` (409) when the source
  revision or the accepted calculation moved, or a calculation turned
  pending, while the files were prepared.
- **Publish / Public assets (relational)** (the **Publish** panel), a manual
  Flow for administrators, with a confirmation. It claims `publication`
  (the button is an explicit request, so it also retries a failed
  publication; it answers 409 `PUBLICATION_NOT_CLAIMED` when another run
  holds the claim, when the calculations are still pending, or when nothing
  is pending: mark publication pending with **Data / Mark pending** to
  publish the current files again). The export operation's `stage` action
  then checks readiness (refusing with the blocker codes), reads, serializes
  and validates every declared file before the first upload, and refuses
  (`EXPORT_UNSTABLE_PREPARATION`) when the source moved since the claim. A
  native Trigger Flow step runs **Publish / One file** once per file,
  serially, in definition order.
- **Publish / One file** keeps the claim alive (a heartbeat that leases
  the claim for the upload), then writes its file through the **Publish
  JSON files** operation (`finki-hub-publish-json`, a single-entry filename
  map, content type `application/json`, an existing file replaced under its
  id) into the storage location its upload step names (`publish`, editable
  in Studio), and records the file's outcome right away with the
  coordinator's `record` action (`uploaded` with its bytes, or `failed` with
  the writer's code). It answers `{ok, filename, outcome, code}` and never
  rejects, so **every declared file is attempted** even after an earlier
  one failed; a claim it cannot keep skips the upload (`skipped`, with the
  heartbeat's own code).

The readiness and preparation Flows call the `finki-hub-exports` operation
(actions `readiness` and `prepare`), which checks the administrator flag
again. Neither holds a coordinator step, so neither is part of a Flow-graph
fingerprint.

The `outcomes` action folds the answers into one outcome per declared file.
When every file was uploaded, the Flow completes the claim: the revision it
prepared (never a later edit) is recorded as published,
`publication_state` becomes `completed` and the Flow answers the outcome
map. Otherwise it fails the claim with `PUBLICATION_PARTIAL` (some files
uploaded; state `partial`) or `PUBLICATION_FAILED` (none; state `failed`),
records the map and answers 502 naming the files not uploaded with their
codes; publication stays pending. Nothing is retried and nothing uploads in
parallel: publish again. A source edit that commits while the files upload
does not change them, since every file was prepared and validated at the
claimed revision before the first upload: when every file was uploaded,
that prepared revision is recorded as published, the Flow answers
`pendingRevision` with the newer source revision, and publication stays
pending for it. There is no multi-object transaction: a file uploaded
before a later failure stays uploaded. If one upload hangs past the claim's
lease, the files after it answer `skipped` with the claim loss, which the
status shows.

`data_operations.publication_outcomes` holds one entry per declared file,
keyed by filename: `{outcome, code, bytes, revision}` with `outcome`
`uploaded`, `failed` or `skipped` (not attempted because the claim could
not be kept), and `revision` the source revision of the run that attempted
it. The publish loop records each entry as soon as the file's upload
answered; the run's final complete or fail then records the whole map. A
run that stops early (a Directus restart, a refused step) therefore still
shows which files it uploaded, and its state is `partial` when a file was
recorded uploaded at its own revision, `failed` when none was; the entries
of files it never reached keep an earlier run's revision. An abandoned
publication says in its message that an upload running at that moment may
have finished without being recorded. The coordinator refuses a filename no
export definition declares (`UNKNOWN_FILE`) and a completion without every
declared file uploaded (`OUTCOMES_INCOMPLETE`), so a new definition adds an
outcome, never a column or a Flow step. `GET
/finki-hub-data-operations/status` reports it as `publication.files`.

How `courses.json` projects the relational rows into its existing keys:

- `professors` is `professors_override` when set, else the course's
  professor assignments in `sort` (then id) order, each its
  `display_override` or its staff member's name, joined with `, ` (so the
  import links a workbook text to staff rows only when that join gives
  the text back: a list separated by `;`, a line break or a bare `,`, or
  with padding, stays one literal review row); `assistants` likewise.
- The curriculum keys come from rows an administrator publishes: every
  published `curriculum_generations` row with a curriculum adds
  `<code>-available` (newest first by `sort`) and a block `<code>-name`,
  `-code`, `-level`, `-semester`, `-channel`, `-prerequisite`, then its
  state keys and `<code>-credits` (the definition declares the 2018 block
  with its credits before its states, the order today's file has), valued
  from the course's curriculum link of that generation and its entry; a
  state key `<code>-state-<program>` exists for every published study
  program of the generation, in program `sort` order, valued by the entry's
  state row of that program. `channel` is true when a linked entry of a
  published generation has its channel. The six per-generation `courses`
  columns publish nothing.
- The year keys follow the published-year rule: one per published academic
  year, keyed by its label, newest first (`sort` descending, then the label
  descending), valued by the course's `course_enrollments` count of that
  year. A new year adds its key once published, and readiness then blocks
  until every course has its count.
- Anything the projection cannot resolve (a missing count, two links of one
  generation, an assignment without a role or a label) refuses the
  preparation with ids only; nothing is guessed.

Relation values are resolved on read, so renaming a staff member or a
curriculum entry shows in the next preparation without any rebuild.

### Customizing Flows

Every managed Flow is a native Directus Flow you can open and edit under
**Settings → Flows**; the business steps (reads, filters, small scripts,
conditions) are visible there. Edits persist in the database: setup reruns,
restarts and container recreation never overwrite them (see
[Supported paths](#supported-paths) for taking a newer template). Keep
these when editing:

- An edit to a Flow of the calculation or publication graph marks that
  graph's domains pending (see [Automatic processing](#automatic-processing)),
  so a calculation reruns with the edited Flow before the next publication.
- A Flow that runs under a claim must call the coordinator (a heartbeat,
  `plan_pages` or `stage_page`) at least once a minute: a claim silent for
  60 seconds is released as interrupted.
- Keep the coordinator steps, the `{{ $trigger.runner }}` target of **Data /
  Run enrollment family**, the relational filter shape of the count query
  (see [Mapped enrollment counts](#enrollment-counts-from-explicit-mappings))
  and the first `Administrator?` condition of every manual Flow.

### Activity rows, retention and caching

Directus writes one `run` activity row for every Flow run that logs
activity: each 15-second tick adds one (about 5,760 a day, also on a
project without the data model); an enrollments run adds one per mapped
rule and one per page (256 for 254 mapped rules on two pages) plus one per
family run and runner, besides the row of the Flow that started it; every
other run adds one. Studio's Flow Logs panel lists revisions, so it shows
nothing for these activity-only Flows; the dashboard shows the last
scheduled runs instead. Directus 12.3.1 prunes
the rows only with `RETENTION_ENABLED=true` (default `false`), after
`FLOW_LOGS_RETENTION` (default `90d`), on `RETENTION_SCHEDULE` (default
`0 0 * * *`) in batches of `RETENTION_BATCH` (default `500`); other activity
follows `ACTIVITY_RETENTION` and revisions `REVISIONS_RETENTION` (both
`90d`). The checked-in Compose file leaves retention off; turn it on in your
own override if the table grows too large.

Without `SYNCHRONIZATION_STORE=redis`, every Directus process fires every
tick; the coordinator's claim lets one of them run.

`CACHE_ENABLED` is off in the checked-in Compose file. The history index
writer and the enrollment completion write through SQL and do not purge the
Directus data cache, so a deployment that enables the cache must purge it
after those runs or accept stale derived rows for the cache TTL.

## Access

Directus has REST and GraphQL APIs, but this setup grants no anonymous
access: no command creates a public permission, every collection is
private, and the only public output is the declared files in the R2 bucket.
The private endpoints of the extensions check the caller:

- `/finki-hub-data-operations/*` (status, snapshot report, the setup
  migrations): administrators only.
- `GET /finki-hub-data-status` and `/finki-hub-data-status/readiness`: an
  anonymous caller gets 401, a caller who is neither an administrator nor a
  holder of the **Data editor** policy 403. Editors read a bounded view
  (states, codes, counts, names and links; no failure text, fingerprint,
  claim owner or record).
- The Search endpoints (`/finki-hub-course-history/options`, `/search`)
  run with the caller's own permissions.
- Every managed manual Flow is on the `data_operations` collection (which
  no editor reads, so the trigger endpoint refuses them) and starts with an
  `Administrator?` condition: import, promotion, publication,
  recalculation and rule seeding are administrator-only, whoever can see a
  button.

The **Data editor** policy that `npm run setup` installs is derived from
the collection roles (`src/editor-policy.ts`) and kept equal to that
derivation: full rights on every editable source; read and update of the
key-source collections except the fields that decide public keys
(`published`, the key text, the position, the parent and whatever the key
source filters on); read only on `moodle_users` and the derived counts and
index; nothing on staging, candidate and status rows; plus read of
dashboards, panels and manual Flows. It never holds what
`src/editor-policy.ts` forbids: create, update or delete on `moodle_users`
(the native CSV import needs them; snapshots go through **Data / Import
Moodle snapshot**), any write to the staging, index, count and coordination
collections, and
any write to Flows, operations, permissions, policies or their assignments
(the managed Flows read and write with `$full`, the schedule without
accountability, so editing one would lift every other rule). Setup attaches
it to no role: attach it to your editing roles under **Settings → Access
Policies**. Which roles get it, and whether editors may publish years,
generations or programs, is an owner decision the setup does not make.

Administrators cannot be restricted that way; readiness flags active Moodle
users changed outside the snapshot workflow (`active_snapshot_edited`) and
a failed import (`snapshot_import_failed`).

**Search and row-restricted roles.** Directus 12.3.1 checks the signed-in
user's field permissions on every segment of a filter path, but joins the
related rows without that user's row permissions (only `_some`/`_none` apply
them), and an implicit `$FOLLOW(collection, field)` segment skips even the
field check; this holds for the REST API too. So a role that may read only
some Moodle users may read, of `moodle_history_memberships`, only `id` and
`entry` of those users' rows (for example with the condition
`moodle_user.Name` starts with the same prefix), never the `moodle_user`
field, and must not be granted the `memberships` alias of
`moodle_course_entries`. With a global memberships read, that field or that
alias, a REST filter through them answers questions about other users.
Search needs none of them, and the raw `Courses` text shows a person's
lines. The person's **History Memberships** list needs the memberships'
`moodle_user` and `sort` fields and reads of the mappings, courses and years
it shows, so it is for roles that read every Moodle user. A read of
`moodle_course_entries` itself lists every line, without its holders.

## Course-history search

Directus Studio's collection table is the native replacement for the
spreadsheet preview/helper tabs. Setup creates global table presets with the
most useful fields and sorting, once; later runs keep whatever Studio
changed. Studio search checks the displayed collection's string and numeric
fields, and the filter builder supports nested include/exclude conditions.

| Spreadsheet helper | Directus replacement |
| --- | --- |
| `Пребарување` | **Search** view on `moodle_users`, with include/exclude course pickers and matching users. |
| `Слушатели` | **Course Enrollment Rules** (one rule per course and year) and the derived **Course Enrollments** counts, both also in the course form's **Enrollment** group; history entries map to courses in **Moodle Course Mappings**. |
| `Индекси` / `Индекси (Export)` | Search/filter the canonical `students` collection, including `source_group`. |
| `Предмети (Export)` | Browse the canonical `courses` collection and its form. |
| `Предмети - 2023`, `Предмети - 2018` | **Curriculum by generation** on **Curriculum Entries**, narrowed with the Generation filter. |

These are normal private Studio views, not separately stored copies. You can
change visible columns, sorting, and filters in Studio and save additional
presets/bookmarks for yourself or the team.

Open **Content → Moodle Users → Search** to use the course-history search
layout. The main **Moodle Users** view keeps the native table for regular
data management. Setup creates this shared bookmark once from
`directus/presets/course-search.json`; both views use the same collection.

- **Has all these courses:** search for and select every required course.
- **Has none of these courses:** select any courses that should exclude a person.
- Remove individual selections or clear both groups. Results update automatically,
  with a matching count, 50 people per page, profile links, and expandable histories.
- Click **Course history** to toggle between most and fewest courses first across
  all matching users, ties by name. Changing the sort returns to the first page.
  People without a stored `Courses Count` (the list shows the number of lines
  of their raw history instead) come after everyone with one, in both
  directions, by name.
- The page header's native search and filters still apply, including filters on
  related fields such as **History Memberships → Entry → Label** or the course
  of an entry's mappings. They run as the signed-in user: a field that user may
  not read answers 403. A filter path passes each collection once, from a
  person through their own memberships to the entries, their mappings and on,
  and names at most `MAX_RELATIONAL_DEPTH` fields (10 by default, as for the
  REST API). A path back to a membership or a person (such as **Entry →
  Memberships** or **History Memberships → Moodle User**), `_some`/`_none`
  quantifiers and implicit `$FOLLOW(...)` relations are refused. Course
  selections are temporary and reset when the layout is reopened; they are not
  saved bookmarks.

Search works on the raw histories. Choices come from the current imported
Moodle histories of the users the signed-in user may read, never from the
history-entry table, so Search never offers or matches another user's
lines. Matching is case-sensitive against complete newline-separated entries
of the raw `Courses` text, including year/semester, not substrings or regex;
it does not go through the history index or the mappings, so a line that is
unmapped, ignored or not indexed yet is found like any other. To reach the
mappings of a person's lines, open the person: the **History Memberships**
list shows each line with its review state and the course and academic year
of its mappings. Up to 20 selections are supported per group. Use **Refresh
data** after importing a new snapshot to reload choices and results. Both
private endpoints use the caller's Directus permissions (see
[Access](#access) for row-restricted roles); no collection data is
duplicated or published.

The layout and its companion endpoint are one bundle in
`directus/extensions/directus-extension-course-search`. Compiled files are
included for Compose. After changing its TypeScript or Vue sources, run
`npm run build:search`, restart Directus, and refresh Studio. Use the main
**Moodle Users** view for the standard collection editing and export
workflow.

## Branding

`npm run brand` applies the shared FINKI Hub logo, favicon, login artwork,
project name, and light/dark palettes through Directus's native Files and
Settings APIs. It works on a fresh or already imported project without
reading the workbook or changing any collection data, permissions, or Flow.
Run it again to restore the repository's appearance after manual changes;
existing branding file IDs are reused. It requires a running Directus and an
administrator token. Unlike the lifecycle commands, it reads `.env`: it takes
`DIRECTUS_URL` (falling back to `http://localhost:8055`) and
`DIRECTUS_TOKEN` or `DIRECTUS_ADMIN_TOKEN` from the environment, then from
`.env`, so values given on the command line win; check both before running
it against another project. Once applied, branding survives container
restarts and recreation; the command does not need to run on startup.

Edit `directus/branding/settings.json` for theme tokens, or use **Settings →
Appearance** in Studio for local adjustments. Inter is bundled with
Directus; no external fonts are required. A small native Custom CSS override
keeps informational notification text readable on the dark theme's green
background. Reapplying branding replaces that setting too. Theme defaults
follow the system preference; individual user theme overrides still take
precedence. Review the notification CSS selectors when upgrading Directus.

The unmodified logo comes from `finki-hub/courses-listing/public/logo.png`
(also shared by the timetables and diplomas projects). Branding files use
the private `local` storage location, persisted in the Compose
`uploads_data` volume. Directus serves the configured logo and public-page
images to the login screen without making collections public. They never
become published files. Keep both `database_data` and `uploads_data` when
moving or backing up this setup. As with the database, `down -v` deletes the
uploads volume; the repository-owned branding assets can be reapplied with
`npm run brand`.

## Backup and restore

A project is its PostgreSQL database and its `uploads_data` volume. The
database holds the schema, every record, the Flows and their Studio edits,
presets and bookmarks, the dashboard, users, the settings (branding, and a
licence Directus activated) and the coordination status, including source
edits the schedule has not processed yet. The uploads volume holds the
branding files and every private file of the File Library (Moodle snapshot
uploads and their backups). The published objects live only in the publish
bucket; they are not part of a backup, and a restored project republishes
them on demand. Keep backups outside every git repository, in a directory
only you can read: a dump holds every password hash, the static API tokens
and unexpired session tokens in plain text, and the licence and the other
encrypted settings, which anyone with the project's `SECRET` can read.

Take a backup with the stack running (no command of this project needs to
be stopped):

```sh
mkdir -m 700 <private dir>
umask 077
docker compose exec -T database pg_dump --format=custom -U directus -d directus > <private dir>/directus.dump
docker compose exec -T directus tar -c -f - -C /directus/uploads . > <private dir>/uploads.tar
(cd <private dir> && sha256sum directus.dump uploads.tar > SHA256SUMS)
```

The dump and the archive are taken one after the other, so make no File
Library change between the two commands: no upload, replacement or
deletion, which includes a Moodle snapshot import and `npm run brand`. A
file added in between only leaves an unused file in the archive, but a
file deleted or replaced in between leaves a restored file row without
its bytes (or with other bytes), and that file must then be uploaded
again. The schedule and a publication write nothing into the uploads
volume, so they can keep running.

A backup counts once it has been restored, not because the files are
non-empty. To restore into a fresh project:

1. Check the set first and stop on any mismatch: `(cd <private dir> &&
   sha256sum -c SHA256SUMS)`. A truncated or altered dump must never reach
   a database.
2. Start an empty PostgreSQL 18 database and an empty uploads volume.
   Refuse a target that already holds any schema object (a table, view,
   sequence, function, type or schema of its own) or any file; never
   restore over a project that holds data.
3. `pg_restore --exit-on-error --single-transaction -U directus -d
   directus` with the dump on standard input, and unpack the archive into
   the new uploads volume (`tar -x -f - -C <volume root>`), giving the
   volume root the owner of `/directus/uploads` in the Directus image
   (`node`, uid 1000).
4. Start Directus on them with the same image, `SECRET` and, for a licensed
   project, the same `LICENSE_KEY` and `PUBLIC_URL`. `SECRET` encrypts the
   persisted licence (and the AI keys) in `directus_settings`: with another
   secret Directus reads no licence at all, and with `LICENSE_KEY` set it
   would then activate the key again as a new project. With the same values
   it finds its own licence and only refreshes it, as on any restart. Never
   run the restored copy and the original project with the same licence at
   the same time. Unless replacing the published objects with the restored
   data is the authorized rollback, also point `STORAGE_PUBLISH_BUCKET`
   (and, for another server, `STORAGE_PUBLISH_ENDPOINT` and its keys) at a
   separate scratch bucket, as `npm run test:restore` does: with the
   project's usual environment a restored copy publishes into the live
   bucket, over the current public files.
5. Sign in, check the branding and the Flows, and resume **Data / Process
   pending** if it was paused: it processes any source edit the backup
   caught before it was counted. When readiness passes, publish into the
   bucket step 4 chose; publish into the live bucket only when that
   overwrite has been authorized.

`npm run setup` does not have to run after a restore: the dump carries the
schema, the database guard functions and triggers, Flows and presets
(setup recreates the functions with `CREATE OR REPLACE` and installs only
what is missing, so a rerun is harmless). Deleting the model's collections
leaves those functions defined; they hold no data, and the next setup
replaces them. A
snapshot of the published objects themselves (for a rollback of the public
files) is a separate step against the bucket.

`npm run test:restore` rehearses this procedure on a disposable project; its
requirements and the recovery of an interrupted rehearsal are under
[Development and tests](#development-and-tests).

## Sizing

Measured on a synthetic full-size project on a developer machine (single
runs, repeated once: the run times within about ten percent, the wall
times within one 15-second tick; not a benchmark): 30,000 Moodle users in
a 41 MB CSV with 5,000 distinct history lines and 113,685 memberships, 400
courses, 16 academic years, 640 curriculum entries and about 6,000 legacy
rules.

| Step | Wall time | Of which the Flow run |
| --- | --- | --- |
| `npm run setup` on an empty project | 14 s | |
| Snapshot import (staging and promotion, one Flow run) | 6.4 s | |
| History index | 13 s | 10 s |
| Enrollment counts, legacy family only (6,045 pairs, 1,573 pages) | 169 s | 162 s |
| **Add enrollment rules** for one new year (403 mapped pairs), with 250 mappings added | 1.5 s | 0.9 s |
| Enrollment counts, both families (6,448 pairs) | 180 s | 165 s |
| Readiness | 0.6 s | |
| Publication (`courses.json` 413 KB, the other files under 120 KB each) | 1.2 s | |

Wall time runs from the start of the step until its result is in place.
For the history index and the counts it includes the wait for the next
15-second tick of the schedule; the last column is the run itself, where
it was measured apart from the step.

The Directus container peaked at 766 MiB during the legacy counts;
PostgreSQL used about 350 MiB besides its page cache. Each readiness or
preparation run hashes every active Moodle user once (to detect edits
outside the snapshot workflow) besides reading the coordination status;
that is included in the 0.6 s above. The legacy family
dominates: its cost grows with history pages times legacy rule pages, one
activity row per page. Converting reviewed legacy rules to mapped rules is
what shrinks it; a mapped pair costs one Flow run and one heartbeat
transaction (about 13 ms, so 10,000 pairs take about two minutes). A parent
delete during the install (see [Automatic processing](#automatic-processing))
changes the counts' inputs, so it costs a whole rerun, about three minutes at
this size, whether or not the install lost a deadlock to it.

## Extending

Every set that grows is declared in exactly one place, and everything that
uses it (schema, forms, bookmarks, export definitions, readiness, the
dashboard, the Flows and the tests) derives from that declaration. What
administrators add in Studio is a row; what changes the public contract,
the correctness boundary or the Flow graph is one code declaration. The
members named below are today's, as examples; the declaration is the
definition.

| Set | Declared in | Today, for example |
| --- | --- | --- |
| Academic years | rows of `academic_years`, with their `published` flag | the years the workbook's **Слушатели** header named |
| Curriculum generations | rows of `curriculum_generations`, with their `published` flag | `2013` (label only), `2018`, `2023` |
| Study programs | rows of `study_programs`, with their `published` flag | `kn`, `siis`, `pit`, `imb`, `ki`, `ke`, `seis` (2018); `kn`, `siis`, `pit`, `imb`, `ki`, `ie`, `ssp`, `seis` (2023) |
| Published files and their keys | `exports/index.ts` and one definition module per file | `courses.json`, `rooms.json`, `staff.json`, `students.json` |
| Keys the data decides | `exports/key-sources.ts` | `published_years`, `published_generations`, `published_programs` |
| Readiness checks and their review views | `exports/readiness-registry.ts` | `enrollment_count_missing`, `entry_needs_mapping`, ... |
| Dashboard actions | **Run operation** panels (Studio); the defaults in `src/data-model/operations-dashboard.ts` | Publish, Recalculate, Import Moodle snapshot, Add enrollment rules |
| Collection roles (editable sources) | `coordination/collection-roles.ts` | `courses`, `curriculum_entries`, `moodle_course_mappings`, ... |
| Rule modes | `rule-modes.ts` | `mapped_entries`, `legacy_regex` |
| Managed Flow families | `flowFamilies` in `src/flows/registry.ts`, each under its two-digit code in `flowFamilyCodes` (`src/flows/flow-template.ts`) | History index, Snapshot import, Mapped enrollments, Legacy enrollments, Publication, Publish, Enrollment rules, Automatic processing |
| Choices of an enumerated field | the field, in `src/data-model/*-collections.ts` | the review states of a history entry |
| Scraper columns | `snapshot/contract.ts` (`snapshotFieldTable`) | the 38 headers of `profiles.csv` |

Code paths in the table that do not start with `src/` are relative to
`directus/extensions/directus-extension-data-operations/src/`. A code
change there needs `npm run build:operations` (the compiled bundle is
committed), a restart of Directus and, where said below, `npm run setup`.
`npm test` checks the declarations against what derives from them (the
export, readiness-registry, Flow-registry, collection-role and rule-mode
tests, among others).

### An academic year and its rules

1. Create the `academic_years` row (label such as `2026/2027`, a `sort`
   above the newest year's). It is unpublished by default.
2. Run **Add enrollment rules** on the dashboard with that year: every
   course gets a `mapped_entries` rule. With a course instead, a new
   course gets one rule per year; with both, one pair. Existing rules of
   any mode are kept, so a rerun creates nothing, and no mapping is
   created. The rules are counted at the next tick (zero where no entry is
   mapped yet).
3. Map the year's Moodle history entries (**Needs mapping**).
4. Set `published` (administrators). `courses.json` gains exactly one key
   per course, the year's label, among the other year keys newest first;
   readiness blocks until every course has a count for it and its `sort` is
   unique.

No event Flow creates rules on its own; readiness warns about mappings
without a rule (`mapping_without_rule`) and blocks a published pair without
one (`enrollment_rule_missing`).

### A curriculum generation or study program

1. Create the `curriculum_generations` row (`code`, `label`,
   `has_curriculum`, `sort`), then its `study_programs` rows (`generation`,
   `code`, `name`, `description`, `sort`). Both stay unpublished.
2. Create the generation's `curriculum_entries` and their program states
   (the program picker offers only the generation's programs), link courses
   in the course form's **Curricula** list, and add equivalency members of the
   generation where they apply. Browse them with **Curriculum by
   generation** narrowed by the Generation filter; the Needs review views
   show the new rows too. No bookmark and no setup rerun is needed.
3. Publish the generation (administrators): `courses.json` gains its
   `<code>-available` key and its block, laid out like 2023 (states before
   credits), newest first by `sort`. Publish each program: it adds its
   `<code>-state-<program>` key in program `sort` order. Unpublishing
   removes the keys again.

### A key or a new published file

Every published file is one export definition, declared in code, in the
data-operations extension: `exports/index.ts` lists the definitions in
publication order, and a definition module (today `courses.ts`, `rooms.ts`,
`staff.ts`, `students.ts`) names

- its `filename` (a root-level `*.json` name the storage writer accepts);
- the native reads it needs: a collection, an explicit field list
  (relational dot paths such as `entry.code` or `staff.name` are resolved
  on read), a sort and an optional filter, never `*`, never `_some` or
  `_none`, never a Moodle user or a private field such as `source_group`;
- `orderBy`, the id field that orders the file;
- the ordered field map: each public key with its value (a source path of
  the row, or a resolver in the same module, such as `professors` or
  `enrollmentCount`) and its value rule: `text` (as is), `number` (its
  decimal text), `numeric_boolean` (`"1"`/`"0"`) or `boolean`
  (`"TRUE"`/`"FALSE"`); every rule omits null, undefined and `''` and keeps
  `false` and `0`, as the public files committed under
  `test/fixtures/expected-exports` do. The map is the file's whole
  allowlist: no other key can be published;
- `maxBytes`, the size bound of the compact JSON.

A key the data decides comes from a key source (`exports/key-sources.ts`, a
closed list): an entry `{ keys: 'published_years', rule, value }` puts one
key per row of that source at its position. `published_years` is every
academic year whose `published` flag is set, newest first, keyed by its
label; `published_generations` and `published_programs` key the curriculum
blocks. Each source declares the field that places its rows (`sort`, among
the programs of one generation for a program): readiness blocks a keyed
row without a sort (`<row>_unsorted`) and two siblings sharing one
(`<row>_sort_shared`), so no key moves silently.

A generic engine (`exports/engine.ts`) reads each definition's sources
through the Directus ItemsService (system rights after the operation's own
administrator check, explicit fields, events off, every nested list read
whole rather than cut to `QUERY_LIMIT_DEFAULT`), serializes the rows in
id order with the value rules, and validates every payload against its
definition (a list of one object per read row, only declared keys and in
their order, non-empty text values, the size bound) before anything is
answered.

To change a file or add one:

1. Edit the file's definition module, or add a new module and append it to
   `exports/index.ts`. Declare every read with explicit fields and every
   key with its rule. When the file needs data that must be complete
   first, add a readiness check that gates it (below).
2. Update the expected output in the tests: `test/relational-export.test.ts`
   pins today's declared files byte for byte to the files committed under
   `test/fixtures/expected-exports` (with their
   `SHA256SUMS`; `test/expected-exports.ts` reads them), and
   `test/export-definitions.test.ts` shows a new definition end to end.
3. `npm run build:operations`, then restart Directus.

No Flow, no schema change and no Studio edit is involved: the publication
Flows only call the export operation, which serves every definition, and
**Publish / Public assets (relational)** uploads whatever the definitions
declare, one file after another in the listed order, recording one outcome
per file. The dashboard lists the new file from the declarations.

### A readiness check

Add one entry to `exports/readiness-registry.ts`: its code, severity, the
source of its count (a plain-filter aggregate over one collection, or a
check counted in code), the files it gates (a blocker gates at least one,
a warning none), whether its records carry a `generation` column, a
description and, when a plain filter lists its records, a review view
(bookmark name, fields, filter, sort). A registry with a code twice, a
blocker gating no published file, a warning gating one, two reviews of one
bookmark or a filter with `_some`/`_none` is refused before anything is
read, and a check several codes share runs once. Then `npm run
build:operations`, restart Directus and run `npm run setup`, which creates
its Needs review bookmark; readiness, `issueCounts`, the **Readiness**
panel and its link follow from the entry.

### A dashboard action

Create a manual Flow in Studio whose name starts with `Data / ` or `Publish
/ `, then on the dashboard **Edit Panels → Create Panel → Run operation** and
pick it. No code changes and no rebuild. Its trigger must be set up like the
installed ones, or the panel refuses to run it and says why:

- **Collections**: `data_operations` only. No editor reads it, so the
  trigger endpoint (which checks nothing but read access to the Flow's
  collection) refuses every non-administrator before the Flow starts.
- **Collection Page (Requires Selection)** off, **Asynchronous** off and
  **Error on Reject** on. An asynchronous Flow answers before it runs and a
  Flow without Error on Reject answers success after a failed step, so the
  panel could not tell a failure from a finished run.
- **First operation**: a Condition named `Administrator?` with the rule
  `{"$accountability":{"admin":{"_eq":true}}}`, whose reject path ends in
  a Throw Error with status `403` and code `FORBIDDEN`, as in every
  installed managed Flow. The Flow itself is the boundary: a user whom
  another policy lets read `data_operations` passes the trigger endpoint,
  and the panel's picker and its "Administrators only" state are
  conveniences, never the check.
- The dialog fields are yours, but the API ignores them: validate every
  input inside the Flow.

A default panel that every project should get is one entry of
`defaultPanels` in `src/data-model/operations-dashboard.ts`, installed by
the next setup; a Flow template that ships with the code belongs to a Flow
family (below).

### An editable source collection

The collection itself is a model declaration (its key in `src/schema.ts`,
its fields in a `src/data-model/*-collections.ts` module, its relations in
`src/data-model/relations.ts`, its place in a sidebar folder in
`src/data-model/presentation/navigation.ts`). Whether it is an editable
source, and which calculations its edits mark pending, is declared once, as
its entry in `coordination/collection-roles.ts`; a test fails for a model
collection without exactly one role. From that entry follow its
statement-level invalidation trigger, the editor grants of the **Data
editor** policy and, for a derived or candidate collection, its write
guard. Then:

1. `npm run generate:invalidation` rewrites the reviewed snapshot
   `source-invalidation.sql` beside `source-invalidation-sql.ts` (a golden
   test fails while it differs from the generated migration).
2. `npm run build:operations`, restart Directus, `npm run setup`.

A source collection is never public by being added: a published file reads
it only through an export definition.

### A rule mode

Add the mode to `rule-modes.ts` (its value, label, description, whether it
reads `pattern`, its planner and page kinds, and the id of the runner Flow
that runs its whole family) and register that family's Flow templates as a
new Flow family (see [A managed Flow family](#a-managed-flow-family)).
Setup then realigns the `mode` choices and installs the new Flows; the
dispatcher needs no edit, because its runner target is templated from the
plan.

Retiring a mode is the reverse: remove it from the declaration and its
family from the registry. The code that takes a mode from the declaration
by name (`ruleMode('<mode>')`) then fails to compile until it changes too,
so nothing seeds or counts an undeclared mode:

- the family's own Flow modules under `src/flows/`, which read their mode
  through `legacyRuleMode` or `mappedRuleMode` in `src/flows/shared.ts`;
- for `legacy_regex`, the one-time import, which seeds every rule it
  reads from the workbook with it (`seededMode` in `src/import/rules.ts`),
  so retiring it also decides what the import seeds;
- for `mapped_entries`, **Data / Add enrollment rules**, which creates
  rules of that mode, and the `rules` plan source (`rulesPlanMode` in
  `rule-modes.ts`).

Setup refuses to realign `mode` while rows still hold the retired value,
and a project keeps the retired Flows installed but never plans them
(dropping them from the fingerprint causes one recount). One refusal text
of `directus/flows/count-history-page.cjs` still names `legacy_regex`
(wording only).

### A managed Flow family

A family is one entry of `flowFamilies` in `src/flows/registry.ts` under
a code of its own. A new family therefore takes two edits:

1. Add its two-digit code to `flowFamilyCodes` in
   `src/flows/flow-template.ts`, a code no other family uses. The type of a
   family code accepts only the declared ones, so a code that is not there
   does not compile.
2. Build the ids of its Flow templates and their operations from that code
   (`familyIds(flowFamilyCodes.<name>)`; every template id carries the
   family code), and add the family's `flowFamilies` entry: the code, a
   name for the setup report and its templates in installation order
   (children before the Flows that call them), before the automatic
   processing entry, which stays last so its first tick finds every child.

Then run `npm run setup` (after `npm run build:operations` and a restart
of Directus when the change also touched the data-operations extension,
as a rule mode does), which installs the new family through the same
loop, once.

### Scraper columns

The scraper contract is `snapshotFieldTable` in `snapshot/contract.ts`,
deliberately exact: the 38 headers of `profiles.csv`, each with how it is
stored (`string`, `text` or `integer`), with no internal field such as
`id`. Everything else derives from that one table: `snapshotFields` and the
lists the CSV validation checks (integer, required and length-bounded
fields), the staging, the backup, the fingerprint, and the columns of
`moodle_users` and its staging twin `moodle_import_rows`. The workbook's
**Courses** sheet (`src/specs/private.ts`) is a fixed historical export: it
lists the scraper fields it carries, whose kinds come from the table, and
the three headers it spells differently. A new scraper column (a change of
the scraper's output) is a change of that table only, followed by
`npm run build:operations`, a restart and `npm run setup`, never an import
option. The workbook has no such column, so the one-time import leaves it
empty, as it does the four fields only the scraper fills.

### Closed on purpose

Correctness and privacy boundaries stay closed and in code, never
Directus-editable rows: the source-invalidation map, readiness severities,
the coordinator's actions and domains (`coordination/domains.ts`), the
value-rule vocabulary of the export definitions, the Search allowlist and
the scraper header set. Nothing here is a general rules language.

## Development and tests

Fixture-free checks, which need no Directus:

| Command | What it does |
| --- | --- |
| `npm test` | Vitest: every unit and contract test, including the declaration tests named in [Extending](#extending). |
| `npm run check` | `tsc --noEmit` and `npm run check:sfc` (`vue-tsc` over the Vue components). |
| `npm run lint` | ESLint over the repository; `npm run format` applies its fixes and rewrites files. |
| `npm run build:operations` | Rebuilds the data-operations bundle into its committed `dist/`; restart Directus afterwards. |
| `npm run build:search` | Rebuilds the course-search bundle into its committed `dist/`; restart Directus afterwards. |
| `npm run generate:invalidation` | Rewrites the reviewed snapshot `source-invalidation.sql` of the data-operations extension from the collection roles. |

The fixture suites run against a disposable Directus only, never a project
holding data. None has a default target or reads `.env`; each validates its
target before its first request, and a suite refuses to run without a
container, S3 target or browser it requires (only the optional subtests
of `npm run test:relational`, which need a container, are reported as
skipped). The target is a licensed Directus built from this repository
(the local image with the extensions mounted), reachable on loopback,
that holds a marker collection and, between runs, nothing of the data
model: the suites install the model through setup themselves and tear it
down afterwards, and refuse a target that already carries a model
collection.
The managed Flow templates stay installed across teardowns (a suite that
edits one restores it), and a suite that drives the coordinator by hand
pauses **Data / Process pending** while it runs. Give the test project a
licence key meant for it, never the key of a project that is running (see
[Requirements](#requirements)): started with another project's key,
Directus activates that key again as a new project.

Every suite takes the target from four variables:

- `DIRECTUS_SEARCH_TEST_URL`: `http://127.0.0.1:<port>` or
  `http://[::1]:<port>`, with no path;
- `DIRECTUS_SEARCH_TEST_TOKEN`: a static administrator token of that
  project;
- `DIRECTUS_SEARCH_TEST_MARKER_COLLECTION`: a collection named
  `synthetic_search_marker_<letters or digits>` on the target;
- `DIRECTUS_SEARCH_TEST_MARKER_VALUE`: a value `synthetic-<letters, digits or
  dashes>` stored exactly once in that collection's `marker` field.

Some suites also take the test project's Docker containers:
`DIRECTUS_COORDINATION_RESTART_CONTAINER` (its Directus container, which
restart scenarios `docker restart`) and
`DIRECTUS_AUTOMATIC_DATABASE_CONTAINER` (its database container, which
statistics subtests `docker exec` into for read-only `psql`; the one
exception is the forced install deadlock of `npm run test:s3`, whose
session only takes locks and rolls back). Every suite
that uses them binds them to the target before it uses them, with
read-only Docker commands (`npm run test:search` and `npm run test:csv`
never use Docker): the Directus container must publish the target's port,
and the database container must be the PostgreSQL server that Directus
connects to, which is read through the Directus container, so the
database container needs the Directus one named too. A container of any
other project is refused before anything restarts or runs in it.
`npm run test:relational`, like the scenario step of
`npm run test:operations`, binds the ones it is given once, before its
first scenario, and exits 2 on a refusal.

The S3 suites need a local S3-compatible server that you start separately
(none ships with this repository) and the target's `publish` storage
location pointed at a synthetic bucket on it through a Compose override of
the test project: `DIRECTUS_S3_TEST_ENDPOINT` (plain `http://` on
`127.0.0.1` or `[::1]` only), `DIRECTUS_S3_TEST_BUCKET` (`synthetic-…`),
`DIRECTUS_S3_TEST_CONTAINER` (the Docker container that publishes that
endpoint's port) and `DIRECTUS_S3_TEST_DIRECTUS_CONTAINER` (the target's
Directus container). The harness refuses `https`, any other host, any other
bucket name and any value naming `amazonaws.com` or
`r2.cloudflarestorage.com`.

| Command | Runs | Needs besides the four target variables |
| --- | --- | --- |
| `npm run test:csv` | `test/directus-csv-import.integration.mjs`: creates a uniquely named hidden collection, imports generated Cyrillic, CJK and emoji text across CSV read boundaries through the native importer, checks every value and deletes the collection. It reads and changes nothing else. | nothing |
| `npm run test:search` | `test/search.integration.mjs` and `test/search-relational.integration.mjs`: Search and its permissions over generated users and the relational aliases. | nothing |
| `npm run test:relational` | Every `test/relational/*.integration.mjs` scenario in turn; `npm run test:relational -- --scenario <name>` runs one (an unknown name lists the known ones and exits 2). | optionally the containers, bound to the target before the first scenario (the database container only together with the Directus one): without them the restart and database-statistics subtests are reported as skipped |
| `npm run test:relational -- --scenario stress` | The opt-in full-size run (`test/relational/stress.opt-in.mjs`, never part of the default run): the [Sizing](#sizing) figures, about 13 minutes. | both containers and the S3 variables |
| `npm run test:operations` | The `operations` scenario, then `test/operations.browser.mjs`, which drives the dashboard in a real browser through the locally installed `agent-browser` CLI (it fails, never skips, without it). `OPERATIONS_BROWSER_SCREENSHOTS` names a directory for its screenshots (a temporary one otherwise). | the S3 variables |
| `npm run test:s3` | `test/publish-flow.integration.mjs` (the publish Flows against the local bucket, including an injected storage failure) and `test/publish-workflow.integration.mjs` (the complete workflow from setup to publication, with the failure, restart, race and extension scenarios). | both containers and the S3 variables |
| `npm run test:restore` | `test/restore.integration.mjs`: the backup and restore rehearsal below. | both containers, the S3 variables and the restore settings below |

Before anything is uploaded, the S3 suites check where Directus uploads,
because the S3 variables only say where the suite reads objects back: the
Directus container must publish the target's port, and its
`STORAGE_LOCATIONS`, `STORAGE_PUBLISH_DRIVER`, `STORAGE_PUBLISH_ENDPOINT`,
`STORAGE_PUBLISH_BUCKET` and `STORAGE_PUBLISH_ROOT` (read with `docker exec
printenv`, never a key or secret) must name the s3 driver, plain `http://`
on a name the S3 container has on a network the two share, at the port it
serves, the synthetic bucket and no root, with no `_FILE` variant. A canary
file written through the publish location must then appear in the bucket
through the loopback endpoint, and is deleted. Otherwise the suite stops
before the first declared file is written, so a Directus configured for the
production bucket is never written to. The suites also refuse to start
while any file is in the publish location, and delete only what they
published. The suite that injects a storage failure makes its bucket folder
read-only for a moment and restores it.

After rebuilding a bundle, restart the test project's Directus container
(`docker restart <container>`, never a recreate) and wait for
`/server/ping` before running a suite.

### The restore rehearsal

`npm run test:restore` rehearses [Backup and restore](#backup-and-restore)
on a disposable project and never touches another one. It needs the target
variables of `npm run test:s3` including both containers, the Compose
environment that the test project's Directus container was created with
(the harness checks that it reproduces the container's configuration hash,
and that the image tag still names the running build, before it changes
anything; it never reads `LICENSE_KEY` itself), and three names of its own:
`DIRECTUS_RESTORE_TEST_NAME` (`finki_restore_` plus 6-32 lowercase letters
or digits; the restore database container, its volume, the uploads volume
and a network alias are derived from it and labelled with it),
`DIRECTUS_RESTORE_TEST_BUCKET` (a second `synthetic-restore-…` bucket in the
same local S3 server, created and removed by the run, so no object of the
test bucket is overwritten) and `DIRECTUS_RESTORE_BACKUP_DIR` (an existing
mode-700 directory outside every git repository). The run keeps its backup
set, the damaged copies and the override each in a `restore-…` directory
directly under it and refuses to start while one of an earlier run is still
there. `DIRECTUS_RESTORE_KEEP_BACKUP=1` keeps the backup set; move it out of
the directory before the next run. `DIRECTUS_RESTORE_SCREENSHOTS` names a
directory for optional browser screenshots.

It builds a project through setup, a generated workbook import and a
generated snapshot import, edits the publish Flow in Studio, adds a
bookmark, the branding, a password user and source edits, leaves one edit
pending, and takes the backup above (plus a manifest). It refuses a
truncated or altered dump, a target name that is not disposable, a target
database holding a schema object (a view) and a target uploads volume
holding a file before writing anything, restores into a fresh PostgreSQL
container and uploads volume, and lets the test project's own Directus
container serve the restored project through one more private Compose
override that changes only the database connection, the publish bucket and
the uploads volume. The restored project must sign in, show its branding
and files byte for byte, keep its Flow edit and bookmark, count the pending
edit on the next tick and publish every declared file into the second
bucket equal to the export recorded before the backup. The container is
then recreated from its own Compose files, and every restore resource, the
bucket and the backup set are removed by exact name; a removal that fails
does not stop the others, and the run then fails naming what was left.

A run takes two to three minutes, about one of them with the test project's
Directus serving the restored copy. Give it at least ten minutes (a
600000 ms tool timeout, for example) and never interrupt it: the switch
back and the cleanup run in the test's own `finally`, which a killed
process (Ctrl-C, a timeout, a crash) skips. The next `npm run test:restore`
then refuses to start, but a suite that binds only the Directus container
would not notice, so recover the test project before anything else runs:

1. Stop its Directus container (`docker stop <container>`) and recreate it,
   with the Compose environment it was created with, from the Compose files
   its `com.docker.compose.project.config_files` label lists, without
   `compose.restore.yaml`: `docker compose --env-file /dev/null -p
   <project> -f <file> … up -d --no-build --no-deps directus`. Wait for
   `/server/ping` to answer 200, check that `GET /license` answers
   `active` with source `env`, and that the label no longer lists the
   override.
2. Remove `<name>_database` (`docker rm --force --volumes`), then
   `<name>_database_data` and `<name>_uploads_data` (`docker volume rm`),
   each only after its `finki.restore.disposable` label reads `<name>`.
3. Delete the objects of the `synthetic-restore-…` bucket, then the bucket.
4. Delete every `restore-…` directory under `DIRECTUS_RESTORE_BACKUP_DIR`
   (backup sets hold a full dump, the override the restore database
   password), file by file.
5. The test project's own database still holds the rehearsal's project with
   **Data / Process pending** paused: resume the schedule, undo the
   rehearsal's edits as `revertsFixture` in `test/restore-project.mjs`
   does (the publish Flow and its claim operation, the bookmark, the
   password user, the appearance settings, and the files and Flows it
   added) and tear the model down to marker-only.
