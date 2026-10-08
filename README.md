# FINKI Hub data in Directus

This repository sets up the private Directus project that holds the FINKI
Hub data: courses and their curriculum, staff, rooms, students, the Moodle
course-history snapshot and the enrollment counts derived from it. Its
few users change source records in Directus Studio with native forms and
publish the declared public JSON files to the R2 bucket by hand, while
native Directus Flows keep the derived data current on their own. The
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
| New, empty project | `npm run setup` | Installs the data model, its database constraints and source-invalidation triggers, the Studio presentation (sidebar folders, forms, a default table view for every collection Studio lists, the **Curriculum by generation** bookmark, one Needs review bookmark per readiness check that declares a review view, and the **Search** bookmark), the private File Library folder **Moodle snapshots (private)**, every managed Flow family (`src/flows/registry.ts`: the history index, the snapshot import, the mapped and legacy enrollment counts, readiness and preparation, publication, rule seeding and automatic processing) and the **Data operations** dashboard. Writes no source records (only the coordination status row), but once it has run the schedule keeps the derived data current on its own. |
| New project, first data from the workbook | `npm run import` | Refuses unless every application collection is empty, runs setup, then imports the workbook once (see [One-time workbook import](#one-time-workbook-import)). |
| Replace the Moodle snapshot | **Import Moodle snapshot** on the **Data operations** dashboard | Replaces every active Moodle user with the rows of an unchanged scraper CSV, after a private backup (see [Replacing the Moodle snapshot](#replacing-the-moodle-snapshot)). |

The import writes only into an empty project and refuses one that already
holds data.

None of them runs by itself: a `docker compose up`, container restart or
recreation installs and changes nothing, because the schema, presets and
Flows live in the PostgreSQL database and the Directus image only serves
them. `npm run setup` and `npm run import` name their target on the
invocation (`DIRECTUS_URL` plus `DIRECTUS_TOKEN` or `DIRECTUS_ADMIN_TOKEN`,
a static token of that project); neither reads `.env` or falls back to a
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
creating a Flow but before wiring it, the command refuses (exit code 2)
with `Flow "<name>" (<id>): entry operation missing` instead of repairing
it: delete that Flow in Studio (**Settings → Flows**) and run the command
again.

A few things are code-owned and kept in step on every rerun:

- The choices of every enumerated field (their labels and the
  server-enforced rule that only they may be stored) are declared once with
  the field (`src/data-model/*-collections.ts`). When an installed field's
  choices, labels or rule differ, setup rewrites exactly those three meta
  keys (`options`, `display_options`, `validation`, merged: a placeholder or
  any other option stays) and reports the field as `aligned`, while the keys
  Studio owns (note, width, group, sort, conditions) are never sent. Before
  that it reads the field's distinct stored values, and when one of them is
  no longer a declared choice it refuses (exit code 2) and changes nothing,
  one line per field (`- Field teaching_assignments.role: 1 value outside
  declared choices: "lecturer"`): change or clear those values in Studio,
  then run setup again.
- Every managed Flow family is registered once in `src/flows/registry.ts`;
  setup installs them in one loop and reports `created` and `skipped` per
  family under `flows.families`.
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
  collection for its licence limit (`collection <name> not created:
  licence collection limit (LIMIT_EXCEEDED); model collections: <n>`):
  remove unused collections or use a licence with a higher limit, then run
  setup again. Directus reads the key from
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

1. Create the local Compose configuration, set `DIRECTUS_ADMIN_EMAIL` and
   replace every `change-*` value (`DIRECTUS_ADMIN_PASSWORD`, the static
   token `DIRECTUS_ADMIN_TOKEN`, a `DIRECTUS_SECRET` of at least 32 bytes
   and `POSTGRES_PASSWORD`). The `STORAGE_PUBLISH_*` values name the R2
   bucket publication writes to (see [Publishing](#publishing)). Every
   publication replaces the objects in that bucket, and readiness does not
   compare row counts, so an empty or half-filled project publishes empty or
   short files. Until the project holds its complete data, point
   `STORAGE_PUBLISH_*` at a separate scratch bucket, never the bucket the
   public consumers read. `DIRECTUS_URL` there is read only by
   `npm run brand`:

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
   DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=<static token> \
     npm run setup
   ```

5. Apply the FINKI Hub appearance with `npm run brand` (it prints
   `Branding succeeded`), then open
   <http://localhost:8055> and sign in with `DIRECTUS_ADMIN_EMAIL` and
   `DIRECTUS_ADMIN_PASSWORD` from `.env`.

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
   (`skipped`) and of the warnings (`warnings`), the count per column of
   the values no column can hold (`unstorable`), and the place of every
   case the import fixes by rule (`fixes`, below). When the import would
   refuse the workbook it exits with code 3: the first stderr line counts
   the cases, and every later line names one case as
   `- [<code>] <place>: <fact>`. A value no column can hold has the code
   `unstorable` and is placed by sheet, row and column, never quoted. A
   blocking case is placed by the sheet and row it concerns, with the
   course after its row (a curriculum code by its cell instead); the table
   below says what to change for each code. The dry run exits with code 1
   when the workbook cannot be read. The lines quote course and curriculum
   names, curriculum codes, 2018 labels, credits, availabilities and the
   Inactive text only, never a staff or student value (a teaching case
   names its cell and line numbers); names, codes and labels stand between
   « and », so a stray space in a cell shows. For example:

   ```text
   Import dry run blocked: 3 cases
   - [ambiguous_curriculum_2023] Предмети (Export) row 3 «Beta Course»: 2023 name «Beta Course» matches Предмети - 2023 rows 6, 9; codes: row 6 «F23L2W002», row 9 «F23L2W009»
   - [unlinked_generation_values] Предмети (Export) row 4 «Gamma Course»: 2018 name empty; 2018 credits 6, 2018 available TRUE
   - [unmatched_staff_name] Наставен Кадар row 7, column "Професори" «Theta Course»: lines 2, 4 not found in Кадар (Export)
   ```

   What to change in the workbook, per code:

   | Code | Change |
   | --- | --- |
   | `unstorable` | Shorten the value, fill in the required cell, or bring the integer into range. |
   | `ambiguous_course_name` | Give each course its own name. |
   | `ambiguous_curriculum_2018`, `ambiguous_curriculum_2023` | Give each subject its own name; when the rows list one subject, give every row its code. |
   | `ambiguous_legacy_equivalency` | Make the 2018 names of the equivalency rows agree, or fill in the course's 2018-name to choose one. |
   | `ambiguous_staff_name` | Give each of the named `Кадар (Export)` rows its own name, and write the intended one on the line. |
   | `ambiguous_student_index` | Correct the index, or keep one student row for it. |
   | `curriculum_code_without_level` | Correct the code to start with `F`, the generation's two digits, `L` and the level, such as `F18L3W055`, or clear it. |
   | `duplicate_role_row` | Delete the repeated rows. |
   | `inactive_course_assistants` | Clear the course's `Асистенти` cell, or write staff names in its professors cell to keep the course active. |
   | `invalid_regex` | Correct the pattern. For the default pattern, add a valid pattern for each year without one, or rename the course. |
   | `invalid_source_row` | Fill in the missing cell, or delete the row. |
   | `missing_override_target` | Correct the 2018-name to the name of a 2018 subject, or clear it. |
   | `unlinked_generation_values` | Fill in that generation's name, or clear the credits. |
   | `unmatched_curriculum_2018_label` | Correct the 2018 name in the equivalency sheet, or fill in the course's 2018-name. |
   | `unmatched_curriculum_2023_label` | Correct the 2023 name to the name of a 2023 subject. |
   | `unmatched_staff_name` | Write each line as the exact name of a `Кадар (Export)` row, one name per line, or add that staff member. |

2. Run the one-time import against the empty project (steps 1 to 3 of
   [Fresh setup](#fresh-setup) first; the import runs setup itself):

   ```sh
   DIRECTUS_URL=http://localhost:8055 DIRECTUS_TOKEN=<static token> \
     WORKBOOK_PATH=finki-hub.xlsx npm run import
   ```

3. Continue with steps 5 and 6 of [Fresh setup](#fresh-setup).

The import reads the whole workbook and checks it before it contacts
Directus, exactly as the dry run does, so a workbook it refuses leaves
Directus untouched:

- A missing or unreadable workbook, a sheet not laid out as the
  2026-10-08 export lays it out (below), or a cell that is not of its
  column's kind (a boolean column holding other text), stops with exit
  code 1, naming the file, or the sheet, row and column
  (`Import failed: Кадар (Export) row 3, column "active": invalid boolean
  "maybe"`).
- Everything the import could not write as the workbook states it stops
  with exit code 3, all of it reported in one run and never by a staff or
  student value: each value the column it is written to cannot hold (a
  string over 255 characters, an integer out of range, an empty required
  value such as a staff member's title, position or email or a room's
  type), named by its sheet, row and column and never quoted, and each
  case below, named by its code, sheet and rows. The cases are a
  relationship with more than one candidate (a course name two courses
  carry, a curriculum name matching curriculum rows of different subjects,
  a council index two students share, two different 2018 labels for one
  course, a teaching line several staff rows carry), a row the model
  cannot hold (a course without a name, a pattern that is no Unicode
  regular expression, a repeated council or dean's office row, a
  curriculum code that gives no level, a teaching line no staff row
  carries, an Inactive course with assistants), and the values the
  published files carry that no relational row could hold: credits of a
  generation without its name (`unlinked_generation_values`), a curriculum
  name, 2018 override or 2018 equivalency label that matches no curriculum
  row (`unmatched_curriculum_2023_label`, `missing_override_target`,
  `unmatched_curriculum_2018_label`). Correct the workbook and run the
  import again; the project is still empty.
- The curriculum sheets are laid out by semester (column A is merged over
  each semester block, and every row of a block takes the block's label
  as its `catalog_order`, which the **Curriculum by generation** bookmark
  sorts by), and a subject that study programs take in
  different semesters is listed once in each of those blocks, every
  listing with the subject's code; its program columns note the semester
  of each program, such as `задолжителен (сем. 5)`. A curriculum name
  (a 2023 name, a 2018 override, or the 2018 label of an equivalency)
  that matches several rows which all carry one code therefore names one
  subject: the course, or the equivalency member, links to the first of
  them (the earliest row, as today's files do) without a finding, and
  every listing is imported as its own curriculum entry. Only rows with
  different codes, or a matching row without a code, refuse the import.
- An availability of FALSE or TRUE with no name and no credits for that
  generation holds no value without a curriculum: the import links no
  curriculum of that generation, and `courses.json` publishes FALSE as the
  course's availability of that generation, as for every course without a
  link of a published generation. FALSE is no case; TRUE is a rule fix
  (`unlinked_availability`, below). An empty availability cell of a linked
  course imports as FALSE.
- Rows no published file ever used are skipped, and the summary counts
  them per kind: a `Наставен Кадар` or `Слушатели` row naming no course
  (`orphan_assignment`, `orphan_pattern`), the `Наставен Кадар` rows of a
  course whose `Предмети (Export)` professors cell is typed
  (`superseded_assignment`, not read), a pattern of a year the sheet does
  not head (`unknown_academic_year`), and the earlier patterns of a
  course and year, of which the last one applies (`duplicate_pattern`).
- What a rule can fix, the import fixes (the workbook file stays as it
  is) and counts as a warning. The summary's `fixes` lists the place of
  each case per code, by sheet, row and column, never a value, in sheet
  and row order:
  - a second or later `Наставен Кадар` row of a course is ignored,
    neither planned nor checked, and the first row is used, as the
    spreadsheet's VLOOKUP did (`duplicate_assignment`; the place names
    the row used);
  - an availability of TRUE of a generation without its name links
    nothing and publishes FALSE, as above (`unlinked_availability`);
  - a formula in a `Слушатели` pattern cell is not read, and that course
    and year take the default `<name>-<year>` pattern
    (`formula_pattern_cell`; the column is the year);
  - a staff name listed again in one teaching cell is linked once
    (`repeated_staff_name`; the place names the cell and the line).

  ```json
  "fixes": {
    "duplicate_assignment": ["Наставен Кадар row 3 (used: row 2)"],
    "formula_pattern_cell": ["Слушатели row 2, column \"2024/2025\""],
    "repeated_staff_name": ["Наставен Кадар row 22, column \"Професори\", line 3"],
    "unlinked_availability": ["Предмети (Export) row 4, column \"2018-available\""]
  }
  ```
- Everything else is imported as the workbook holds it, and what deserves
  a look in Studio is counted under `warnings`. Readiness counts some of
  these again afterwards (an equivalency label that matches no entry, a
  council index no student carries); others only the import counts
  (curriculum rows no course names, `unreferenced_rows`).

The codes both summaries print (declared in `src/import/findings.ts`; a
rule fix is a warning whose places `fixes` lists):

| Code | Group | Meaning |
| --- | --- | --- |
| `ambiguous_course_name` | refuses | A teaching, pattern or equivalency row names a course name that several courses carry. |
| `ambiguous_curriculum_2018` | refuses | A course's 2018 name (its override or its equivalency label) matches several 2018 curriculum rows that carry different codes, or one without a code. |
| `ambiguous_curriculum_2023` | refuses | A course's 2023 name matches several 2023 curriculum rows that carry different codes, or one without a code. |
| `ambiguous_legacy_equivalency` | refuses | The equivalency rows of a course carry different 2018 labels. |
| `ambiguous_staff_name` | refuses | A line of a teaching cell names a staff name several `Кадар (Export)` rows carry; the line places the cell and names the rows. |
| `ambiguous_student_index` | refuses | Several students carry the index of a council row. |
| `curriculum_code_without_level` | refuses | A curriculum row, linked or not, has a non-empty code that does not start with `F`, two digits, `L` and a digit, so it gives no level (the database refuses such a code as well); the line places it by sheet, row and column `Код`. |
| `duplicate_role_row` | refuses | A council or dean's office row repeats the year, person and position of another. |
| `inactive_course_assistants` | refuses | A professors cell of `(неактивиран предмет)` with an assistants cell that is neither empty nor the same text. |
| `invalid_regex` | refuses | An enrollment pattern of a course (from `Слушатели`, or the `<name>-<year>` default) is no Unicode regular expression. |
| `invalid_source_row` | refuses | A row the model cannot hold: a course without a name, a pattern row without a course, year or pattern, a council row without an index. |
| `missing_override_target` | refuses | A course's 2018 override matches no 2018 curriculum row. |
| `unlinked_generation_values` | refuses | A course has credits of a generation but no name of that generation (an availability alone is a rule fix or no case). |
| `unmatched_curriculum_2018_label` | refuses | The 2018 label of a course's first equivalency row matches no 2018 curriculum row. |
| `unmatched_curriculum_2023_label` | refuses | A course's 2023 name matches no 2023 curriculum row. |
| `unmatched_staff_name` | refuses | A line of a teaching cell matches no `Кадар (Export)` name exactly (no trimming); the line places the cell and the lines. |
| `duplicate_pattern` | skipped | An earlier pattern of a course and year; the last one applies. |
| `orphan_assignment` | skipped | A `Наставен Кадар` row naming no course. |
| `orphan_pattern` | skipped | A `Слушатели` pattern row naming no course. |
| `superseded_assignment` | skipped | A `Наставен Кадар` row of a course whose `Предмети (Export)` professors cell is typed; it is not read. |
| `unknown_academic_year` | skipped | A pattern of a year the `Слушатели` sheet does not head. |
| `ambiguous_equivalency_entry` | warning | An equivalency label matches several curriculum rows of its generation that carry different codes, or one without a code; the member keeps the label without an entry. |
| `duplicate_assignment` | warning | A second or later `Наставен Кадар` row names a course; it is ignored, and the first row is used (rule fix). |
| `duplicate_course_name` | warning | Several courses share one name. |
| `duplicate_equivalency` | warning | Several equivalency rows name one course, with no conflicting 2018 label. |
| `duplicate_staff_name` | warning | Several staff rows share one name. |
| `duplicate_student_index` | warning | Several students share one index. |
| `equivalency_label_after_precedent` | warning | A course has no 2018 override, and its first equivalency row, which decides, has no 2018 label while a later one has, so the course gets no 2018 link. |
| `formula_pattern_cell` | warning | A `Слушатели` pattern cell holds a formula; it is not read, and that course and year take the default pattern (rule fix). |
| `label_metacharacters` | warning | A course name holds a regular-expression or `LIKE` metacharacter, so its default `<name>-<year>` pattern matches differently than it reads. |
| `orphan_equivalency` | warning | An equivalency row whose 2023 label names no course; it is imported without a course. |
| `repeated_staff_name` | warning | A staff name listed again in one teaching cell; it is linked once (rule fix). |
| `unlinked_availability` | warning | A course has an availability of TRUE of a generation but no name of that generation; it links nothing and publishes FALSE (rule fix). |
| `unmatched_council_index` | warning | A council index no student carries; the member is imported, labelled by the index. |
| `unmatched_equivalency_entry` | warning | An equivalency label matches no curriculum row of its generation; the member keeps the label without an entry. |
| `unreferenced_rows` | warning | Curriculum rows no course names; they are imported as entries without a course link. |

It then refuses, before its first write, a project in which any application
collection (every collection the import fills, the relational collections,
the Moodle staging and index collections) holds a record, and names the
record count of each (`Import refused: project not empty: 1 record in 1
collection (courses 1)`); the empty schema `npm run setup` creates, including
its coordination status row, is accepted. On an accepted project it:

1. runs exactly what `npm run setup` runs, so importing into an empty project
   equals setup followed by the import;
2. writes the relational rows in dependency order, in batches of 250, each
   reference set to the id Directus answered for the row it names (see
   [What the workbook fills](#what-the-workbook-fills)): the academic years,
   curriculum generations and study programs; the staff, rooms, students,
   Discord channels, dean's office and Moodle users; the courses with
   their status; the curriculum entries with their program states; the
   course links; the enrollment rules; the staff links; the equivalencies
   with their members; the council.

The import reads the layout of the 2026-10-08 export, and an older export
stops before Directus is contacted (exit code 1, `Import failed: Слушатели
row 1, column 2: not an academic year`):

- **Слушатели**: column A is the course. From column B to the sheet's last
  column, a row-1 label such as `2025/2026` starts a group of three
  columns, and the group's third column holds the patterns. The two other
  row-1 cells of a group are empty (a label merged over its group leaves
  them empty); an empty row-1 cell outside a group is skipped. Any other
  row-1 text, a year heading two groups, a sheet without a year, or groups
  not running newest first stop the import. A later year is one more
  group, placed first.
- **Courses**: every field of the scraper contract under its own header
  (see [Scraper columns](#scraper-columns)); a missing one stops the import
  (`Import failed: Courses row 1: missing column "ID_old"`). A filled
  `ID_old` or `ID_new` is a positive id, unique within its column, as the
  snapshot import requires; the refusal names the cell, never the id
  (`Courses row 9, column "ID_new": repeats the id of row 4`).

The academic years it writes are the ones the **Слушатели** sheet heads, in
its order (published, the oldest sorting first), with one `legacy_regex`
rule per course and year. The curriculum generations and study programs
come from the curriculum sheets: each program column is headed by its
program code on the first line (a second line, such as the duration, and a
link are ignored); the generations with a curriculum sheet and their
programs are published, the label-only 2013 generation is not.

It runs no Flow and never publishes.

The import is not one transaction, and its check for an empty project and
its first write are not atomic against another writer: let nobody write to
the project while it runs. If it stops after it started writing rows, it
exits with code 4, and the message ends with the planned rows Directus had
confirmed (`Import interrupted: <cause> (rows confirmed: 1043/2310)`).
There is no resume: set up a fresh project (new Compose volumes, or the
backup taken before the import) and import again. When Directus confirmed
no row, the project may be empty, and the import runs again (it refuses,
listing them, if the failed request stored rows after all).

Publish through **Publish / Public assets** once readiness passes (see
[Publishing](#publishing)).

There is no update, merge, reconciliation, or ongoing Google Sheets
synchronization mode. After the import, Directus is the source of truth.

### Replacing the Moodle snapshot

A whole Moodle snapshot replaces the active one through the controlled
import, run from Studio. The scraper's output is used unchanged: the
[`courses-scraper`](https://github.com/finki-hub/courses-scraper)
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
   local storage location. The import refuses a CSV outside that folder.
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
empty lines at the end are ignored. Every value is kept exactly as written
but for the scraper's formula guard: the scraper writes a `'` before a value
that starts with optional whitespace and `=`, `+`, `-` or `@`, and the
import drops exactly that `'`, as Google Sheets does on the workbook path,
so both paths store the same value. Such a `'` at the start of a value the
scraper did not guard, a restored backup's included, is dropped as well.
`Name` is required, and a populated `ID_old` or `ID_new` must be a positive
id that is unique within its own column, the rule the one-time import also
applies to the workbook's **Courses** sheet. A history line longer than
2,048 bytes is staged unchanged and reported, because the history index
will refuse that user until the line is shortened at the source. The Flow then
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
`GET /finki-hub-data-operations/snapshot` reports the import state, the
staged and active row counts with their fingerprints, the backup, the
last error, the snapshot the last promotion made active, and
whether the active rows still equal it (`activeMatchesPromotion`, false
after an edit outside this workflow, whatever later imports did). A failed
run logs its code and the database object involved, never a value, to the
Directus log.

### Exit codes

`npm run setup`, `npm run import` (and its dry run) and `npm run brand`
exit with one of these codes. A run that does not succeed writes one first
line to stderr, `<Command> <outcome>: <reason>`, where the command is
`Setup`, `Import` (the dry run included; its blocked header alone reads
`Import dry run blocked`) or `Branding` and the outcome follows the exit
code; every later line starts with `- ` and names one case. The lines
state facts only; what to do is here.

| Code | First stderr line | Meaning | What to do |
| --- | --- | --- | --- |
| 0 | none | Done. Setup and the import print their summary as JSON on stdout; branding prints `Branding succeeded`. | Nothing. |
| 1 | `<Command> failed: <reason>` | Failed before any row was written: a workbook that cannot be read (`workbook <path>: not readable as .xlsx (…)`), a sheet in another layout (`Слушатели row 1, column 2: not an academic year`) or a cell that is not of its column's kind, a target that answers an error (`GET /collections: HTTP 401 INVALID_CREDENTIALS: …`), a target that does not answer (`… no response (ECONNREFUSED)`, `… timed out after 120 s`), or an unexpected error. After an unexpected error the schema or Flows may be partly installed. | Correct what the reason names: the file or cell, the URL, or the token (a static token of that project for `INVALID_CREDENTIALS`), then run the command again; rerunning setup is safe. |
| 2 | `<Command> refused: <reason>` | Refused before any record was written: no explicit target (`DIRECTUS_URL not set (.env not read)`), an unexpected or duplicate argument, a populated project offered to the import (`project not empty: …`), existing definitions the model cannot carry (`data model: <n> incompatible definitions`, then one `- <Kind> <path>: <live>, expected <declared>` line each, including a table or column Directus does not manage), a licence that caps the collections, a half-installed Flow (`Flow "<name>" (<id>): entry operation missing`), or a Directus without the data-operations bundle. Branding refuses an unexpected argument, a missing token or an invalid `DIRECTUS_URL`. | Pass the target on the invocation; drop the argument; import into an empty project (below); change or clear the definitions or values each `- ` line names in Studio; raise the licence limit ([Requirements](#requirements)); delete the named Flow in Studio; build and load the data-operations bundle. Then run the command again. |
| 3 | `Import blocked: <n> cases` (`Import dry run blocked: …` for the dry run) | Import only: the workbook holds values no column can hold or cases the import cannot write as it states them, one `- [<code>] <place>: <fact>` line each. Nothing was sent to Directus. | Correct the workbook as the table under [One-time workbook import](#one-time-workbook-import) says for each code, then run the dry run and the import again. |
| 4 | `Import interrupted: <cause> (rows confirmed: <n>/<m>)` | Import only: the import stopped after it began writing rows; Directus had confirmed `<n>` of the `<m>` planned rows. | Set up a fresh project (new Compose volumes, or the backup taken before the import) and import again (see above). |

A populated project is never imported into: import into a new, empty
project instead (fresh Compose volumes and `npm run setup`, or the import
alone), or restore the backup taken before the first import and import
again.

Messages name counts, codes, ids, paths, sheets, rows, columns, academic
years and collections. A refused boolean or integer cell and a refused
curriculum program header (with the code expected there) are quoted so
they can be found; a refused id cell or `Слушатели` row-1 cell is named by
its row and column only. The line naming a case the import refuses quotes
the course and curriculum names, curriculum codes, 2018 labels, credits and
availabilities it concerns; no other workbook or snapshot value is printed,
and never a staff or student value.

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
`Слушатели` only its explicit patterns, one per course and year group (found
by its year label in row 1) whose pattern cell, the group's third column,
holds a value rather than a formula (a formula cell is reported,
`formula_pattern_cell`). The import writes the
relational rows straight from them:

| Sheet | Relational rows |
| --- | --- |
| `Предмети (Export)` | `courses` (name, tags); the 2023 and 2018 name, credits and availability of each course become its `course_curricula` links (a name that matches several listings of one subject links the first); a `professors` cell typed over the formula, with the `assistants` the row shows, is the course's teaching instead of its `Наставен Кадар` row (below) |
| `Кадар (Export)` | `staff` |
| `Простории (Export)` | `rooms` |
| `Индекси - Година`, `Индекси - Други` | `students` |
| `Предмети - 2023`, `Предмети - 2018` | `curriculum_generations`, `study_programs` (from the program column headers) and `curriculum_entries` with their `curriculum_entry_program_states`, one entry per sheet row, orphans, duplicates and every semester-block listing of a subject included; `Ниво` is not read, because the level is the digit after `L` in the code |
| `Еквиваленции` | `course_equivalencies`, linked to the course its 2023 label names, each filled label a `course_equivalency_members` row; one label column per generation, headed `Предмет (<generation code>)`. The column of a label-only generation (2013) may be missing and then reads as empty; a missing column of a generation with a curriculum, a header that names no known generation, or a filled cell under an empty header stops the import (exit code 1) |
| `Наставен Кадар` | the course's **Status** and its `teaching_assignments` staff links: one per line naming a `Кадар (Export)` row exactly, professors then assistants in cell order (`sort`); a professors cell of exactly `Сите професори` gives All professors, of exactly `(неактивиран предмет)` Inactive (its assistants cell empty or the same text) |
| `Слушатели` | `academic_years` from the labels heading its year column groups, and one `course_enrollment_rules` row per course and year, whose pattern is the sheet's pattern where one exists (see [legacy rules](#enrollment-counts-from-legacy-rules)) |
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
output. The workbook's `Courses` sheet carries every one of those fields
under its own header, so the one-time import fills the same fields as a
snapshot. A row without `ID_new`, an account only the old Moodle instance
shows, is imported with its `ID_old`.

Values the import cannot relate unambiguously but can keep (an equivalency
label that matches no single subject, a council index that matches no
student) are kept as literal labels and counted by readiness. Nothing is
guessed: an ambiguity a published value depends on, every value the
published files carry that no relational row could hold, and every
teaching line that names no single staff row, refuses the import instead
(exit code 3). The exceptions: an availability of TRUE or FALSE of a
generation a course has no name for holds no value, so the import links
nothing and `courses.json` publishes FALSE for that availability, as for
an empty cell; a second or later teaching row of a course is ignored and
the first is used; a formula pattern cell is not read; a staff name
listed again in one teaching cell is linked once. Each of these but FALSE
is a rule fix, a warning placed under `fixes`. Only rows no published file
ever used are left out, and the import counts them (see
[One-time workbook import](#one-time-workbook-import)).

### Editable, derived and bookkeeping collections

Each collection has one role, declared once in
`directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.ts`.
The role decides which calculations an edit marks pending and whether the
database guards the table:

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
  which also decide the database guard that keeps the key text of a
  published row.
- **`moodle_users`**: the active snapshot. Replaced as a whole by the
  snapshot import; a row corrected in Studio is reported by readiness
  (`active_snapshot_edited`) and replaced by the next import.
- **Derived** (`moodle_history_memberships`, the history index;
  `course_enrollments`, the counts): written only by their own runs. The
  database refuses every other write (`Write refused: course_enrollments
  (derived; writer: enrollments claim completion)`), so edit the sources
  instead. The course form still shows edit and delete buttons on
  its derived **Enrollments** rows; the guard refuses them.
- **Candidate, staging and status** (`data_operation_results`,
  `moodle_import_rows`, `data_operations`): bookkeeping of the running
  operations, never edited by hand. The **Data Operations** singleton keeps
  its bookkeeping (source revision, last error) across everything, and
  setup never resets it.

A course holds only what `courses.json` publishes from it directly (name,
tags, status); its curriculum lives in its links, its staff in its staff
links, and a council member is named by the linked student (its index
labels an unlinked one).

### Academic years, curriculum generations and study programs

These are rows managed in Studio, never a code list:

- `academic_years` (`label` such as `2025/2026`, `sort`, `published`).
- `curriculum_generations` (`code` such as `2023`, `label`,
  `has_curriculum`, false for a label-only generation, `published`,
  `sort`).
- `study_programs`, one row per program per generation (`generation`,
  `code` such as `kn`, `name`, `description`, `published`, `sort`).

A new row never adds a public key by itself: a year, generation or program
reaches `courses.json` only once its `published` flag is set (a program
also needs its generation published). The database keeps the key text of
a published row: changing the label of a published year or the code of a
published generation or program answers 400 `INVALID_FOREIGN_KEY`;
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
equivalency members, its status and staff links, the
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
- **Status** decides what `courses.json` publishes as professors and
  assistants: Active the names of the course's staff links in their drag
  order, All professors `Сите професори` as professors (assistants still
  from the links), Inactive `(неактивиран предмет)` as both. A new course
  starts Active, and publishing is blocked while an Active course has no
  professor; see [Publishing](#publishing).
- A row of a course's **Teaching staff** (a staff member's **Teaches**)
  needs its course, staff member and role. The database refuses a second
  link of one person in one role of a course; the same person may be both
  professor and assistant. Taking a row out of either list, or deleting
  the course or the staff member, deletes the link. When that removes an
  Active course's last professor, publishing is blocked until another is
  added.
- **Available** on a curriculum link is on or off, never empty; a new link
  starts on.
- The **Code** of a curriculum entry gives its level, the digit after `L`
  (`F18L3W055` is level 3); there is no Level field. The database refuses a
  code that does not start with `F`, two digits, `L` and a digit (400
  `INVALID_FOREIGN_KEY` on `code`) from every writer. Only that start is
  read: `F18L3S07` is level 3, and the two digits are not compared with the
  generation. An empty code is allowed and publishes no code and no level.
- **Title**, **Position** and **Email** of a staff member and **Type** of a
  room are required, because `staff.json` and `rooms.json` carry them on
  every row; see [Publishing](#publishing).

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
  manual Flow on the hidden **Data Operations** singleton. It marks the
  chosen domains pending (the history index and the enrollment counts
  when none is chosen) and answers the status.
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

`GET /finki-hub-data-operations/status` reports each domain under
`domains` with `state` (`current`, `pending`, `running` or `failed`),
`current`, and `waitingFor`, the pending domains it runs after.
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
another. The same holds for every relational filter.

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
rule, so it is never counted), `course_without_professor` (an Active
course without a professor link, whose professors `courses.json` cannot
publish). Today's warnings: `mapping_without_rule` (mappings nothing
counts), `mapped_entry_awaiting_review`,
`entry_needs_mapping` (Moodle lines nobody mapped, administrative ones
included), `equivalency_without_course`, `equivalency_entry_unresolved` (an
equivalency with a member label of a generation with a curriculum linked
to no entry of that generation), `council_member_unresolved` (a council
membership linked to no student), `snapshot_staged`,
`active_snapshot_edited` and `snapshot_never_promoted`.

A value of the workbook that the relational rows could not publish as it
stands (a curriculum name that matches no entry, credits without a name)
never reaches readiness: the import refuses the workbook until it is
corrected (see [One-time workbook import](#one-time-workbook-import)), so
the first publication loses or changes no text silently. The exceptions
are the import's rule fixes, listed there, each a warning placed under
`fixes`, and an empty availability cell, which publishes FALSE without a
finding. An availability without a name links nothing, and `courses.json`
publishes FALSE for it, as for every course without a link of that
generation: a FALSE is kept, and a TRUE is the rule fix
`unlinked_availability`.

Unmapped Moodle lines only warn: map an entry, mark it `ignored` with a
reason, or leave it counted by a reviewed legacy rule; administrative lines
need no course.

A check's description, the tooltip of its code in the **Readiness** panel,
states the fact only. What to do:

| Check | What to do |
| --- | --- |
| `history_index_pending`, `enrollments_pending`, `history_index_running`, `enrollments_running` | Nothing: **Data / Process pending** runs the calculation at its next tick. |
| `history_index_failed`, `enrollments_failed` | Correct what the last failure names ([Error codes](#error-codes)), then retry with **Recalculate** (**Data / Mark pending**); an edit of an input retries it too. |
| `snapshot_import_failed` | Run **Data / Import Moodle snapshot** again. |
| `enrollment_count_missing` | Add the course's rule for that year (`enrollment_rule_missing`), or let the pending count run; a missing count is never published as 0. |
| `enrollment_rule_missing` | Run **Add enrollment rules** for the year or the course. |
| `course_without_professor` | Add a professor to the course's **Teaching staff**, or set its **Status** to All professors or Inactive. |
| `entry_needs_mapping` | Map the entry, or mark it `ignored` with a reason. |
| `mapping_without_rule` | Add the enrollment rule of the mapped course and year. |
| `academic_year_unsorted`, `curriculum_generation_unsorted`, `study_program_unsorted` | Give the published row a `sort`. |
| `academic_year_sort_shared`, `curriculum_generation_sort_shared`, `study_program_sort_shared` | Give each published row its own `sort` (a program within its generation). |

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
| **Council members without a student** | `student_council` | `council_member_unresolved` | memberships without a student |
| **Published academic years / curriculum generations / study programs without a sort** | the key source's collection | `academic_year_unsorted` and the like | published rows without a position; a program shows its generation and name |

The checks no plain filter can list (a missing row, a duplicate) link
their collection page instead: today `enrollment_count_missing`,
`enrollment_rule_missing`, `course_without_professor`,
`mapping_without_rule` and the three `*_sort_shared` blockers.

Curriculum views show the generation and filter through the
`curriculum_generations` relation, so a new generation's rows appear in
the existing views. A view filters with plain field and relational paths
(never `_some`/`_none`) and with `_empty`/`_nempty` for text (Studio runs
it through the REST API, which refuses an empty string as a filter
value). Each view lists exactly the records its check counts.

Keep a view's bookmark name when editing it. Setup recognises a view by
its collection and name: after a rename, the next `npm run setup` creates
the declared bookmark again beside the renamed one, and the Readiness
panel links the declared name.

### The Data operations dashboard

`npm run setup` installs one Insights dashboard, **Data operations**, with
its default panels, once (a rerun creates a missing panel and never
overwrites an edited one):

- **Run operation** panels for Publish (**Publish / Public assets**),
  Recalculate (**Data / Mark pending**), Import Moodle snapshot
  (**Data / Import Moodle snapshot**) and Add enrollment rules
  (**Data / Add enrollment rules**). A panel shows its Flow's own
  confirmation text and dialog fields (the snapshot's private CSV through
  an item picker of the private folder's files) and posts them to the native
  `POST /flows/trigger/:id`. Run is disabled while any data operation holds
  the coordinator's claim (`Waiting: claim held by <domain>`, with
  ` (stale)` once its process stopped heartbeating), while a run started
  from a panel of the page is in flight (`Waiting: run in progress on this
  page`) and while the data status cannot be read (`Data status read
  failed: <CODE>`; it reads the status again on its own). Every Run opens
  the dialog empty, so each replacement or publication is confirmed again. A
  run that succeeded shows `Succeeded` and the keys of the Flow's answer;
  a failed one shows `Failed: <CODE>` and the Flow's message, with a
  **Retry** that reopens the same Flow's dialog with the failed run's
  inputs, less its checkboxes (acknowledgements such as "Replace the whole
  active Moodle snapshot" are ticked again for every run).
  [Error codes](#error-codes) says what each code means. **Edit Flow**
  opens the Flow's configuration.
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
  set. Facts read `Label: value · Label: value`. A blocking last failure
  shows its code with its domain, revision, time and retries (the failing
  step's message under **Message**): run the operation again, or mark the
  domain pending with **Recalculate** (**Data / Mark pending**). A read the
  endpoint refuses reads `Data status read refused: <CODE>` (`Readiness
  checks …` for the readiness section); a read that failed, `… read
  failed: <CODE>`. The panels poll only while work is in flight (a claim, a
  running domain or a pending calculation) or a run of the page is running:
  a run started in another tab shows at the next such poll or when the page
  is refreshed.

**Add enrollment rules** creates the missing `mapped_entries` rules of an
academic year (every course), a course (every year) or one pair, in batches
of at most 250; see [Extending](#an-academic-year-and-its-rules). A run that
fails in a later batch keeps the batches it created; run it again to add
the rest.

To put another operation on the dashboard, see
[A dashboard action](#a-dashboard-action).

### Publishing

Publication is manual: nothing is published automatically, and nothing
becomes public except through a declared export definition (see
[Extending](#a-key-or-a-new-published-file)).

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
string representations the public consumers already read. A file also
declares the keys its consumers read on every row: `name`, `professors`
and every `<code>-available` of `courses.json`; `name`, `title`, `position` and
`email` of `staff.json`; `name`, `type` and `location` of `rooms.json`. A
row without one, or with an empty one (an empty text is omitted), refuses
the preparation before anything is uploaded, with `EXPORT_INVALID_PAYLOAD`
naming the file, the row (counted from 0 in id order) and the key, never a
value: `staff.json row 12: required key title missing`. Configure the
`STORAGE_PUBLISH_*` variables shown in `.env.example`: for Cloudflare R2,
the account S3 endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`),
region `auto`, the existing bucket name, and an Object Read & Write token's
Access Key ID and Secret Access Key (a token for the scratch bucket until
the cutover). The files are written through Directus's `publish` storage
location.

`npm run setup` installs, once under stable ids (a Studio edit of any of
them survives every later setup):

- **Data / Validate readiness**, a manual Flow on **Data Operations**,
  answers `{ready, revision, blockers, warnings, issueCounts, links,
  reviews, blockedFiles}`: a count for every registered code, the Studio
  page and Needs review bookmark of each positive one and the files the
  blockers hold back, never a name or a row.
- **Publish / Prepare public assets**, a dry preparation: readiness, then
  every file read, serialized and validated, then the source revision
  again. It answers `{revision, files: [{filename, rows, bytes, sha256}],
  warnings, durationMs}` and uploads nothing. It refuses with
  `EXPORT_NOT_READY` (409, before any file is read) while readiness has a
  blocker, and with `EXPORT_UNSTABLE_PREPARATION` (409) when the source
  revision or the accepted calculation moved, or a calculation turned
  pending, while the files were prepared.
- **Publish / Public assets** (the **Publish** panel), a manual Flow with
  a confirmation. It claims `publication` (the button is an explicit
  request, so it also retries a failed publication; it answers 409
  `PUBLICATION_NOT_CLAIMED`, `Publication not claimed: <reason>`, when
  another run holds the claim (`busy`), when the calculations are pending
  (`upstream_dirty`), or when nothing is pending (`nothing_pending`): mark
  publication pending with **Data / Mark pending** to publish the current
  files again). The export operation's `stage` action then checks
  readiness (refusing with the blocker codes), reads, serializes and
  validates every declared file before the first upload, and refuses
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
(actions `readiness` and `prepare`). Neither holds a coordinator step, so
neither is part of a Flow-graph fingerprint.

The `outcomes` action folds the answers into one outcome per declared file.
When every file was uploaded, the Flow completes the claim: the revision it
prepared (never a later edit) is recorded as published,
`publication_state` becomes `completed` and the Flow answers the outcome
map. Otherwise it fails the claim with `PUBLICATION_PARTIAL` (some files
uploaded; state `partial`) or `PUBLICATION_FAILED` (none; state `failed`),
records the map and answers 502 with `Uploaded <n> of <m>; failed:
<file> (<CODE>), …. First failure: <cause>`; publication stays pending.
Nothing is retried and nothing uploads in parallel: publish again once the
cause is fixed. A source edit that commits while the files upload
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
publication reads `Publication claim abandoned: no heartbeat for <n> s.
Revision not published. Last upload possibly unrecorded`: an upload running
at that moment may have finished without being recorded, so publish
again. The coordinator refuses a filename no
export definition declares (`UNKNOWN_FILE`) and a completion without every
declared file uploaded (`OUTCOMES_INCOMPLETE`), so a new definition adds an
outcome, never a column or a Flow step. `GET
/finki-hub-data-operations/status` reports it as `publication.files`.

How `courses.json` projects the relational rows into its existing keys:

- `professors` and `assistants` follow the course's `status`. Active:
  the staff names of the course's professor links, and of its assistant
  links, each in `sort` (then id) order, joined by line breaks; an Active
  course without a professor refuses the preparation, and readiness
  blocks it first (`course_without_professor`). All professors:
  `Сите професори` as professors, assistants from the links. Inactive:
  `(неактивиран предмет)` as both. `assistants` is left out without an
  assistant link. The links of a role the status replaces are kept and
  not published.
- The curriculum keys come from published rows: every published
  `curriculum_generations` row with a curriculum adds `<code>-available`
  (newest first by `sort`; the link's availability, FALSE for a course
  without a link of that generation, so every course carries it) and a
  block `<code>-name`,
  `-code`, `-level` (the digit after `L` in the entry's code, left out
  without a code), `-semester`, `-channel`, `-prerequisite`, then its
  state keys and `<code>-credits` (the definition declares the 2018 block
  with its credits before its states, the order today's file has), valued
  from the course's curriculum link of that generation and its entry; a
  state key `<code>-state-<program>` exists for every published study
  program of the generation, in program `sort` order, valued by the entry's
  state row of that program. `channel` is true when a linked entry of a
  published generation has its channel.
- The year keys follow the published-year rule: one per published academic
  year, keyed by its label, newest first (`sort` descending, then the label
  descending), valued by the course's `course_enrollments` count of that
  year. A new year adds its key once published, and readiness then blocks
  until every course has its count.
- Anything the projection cannot resolve (a missing count, two links of one
  generation, an assignment without a role or a staff name, an Active
  course without a professor, a status outside its three values) refuses
  the preparation with ids only (`Course 12: professor missing`); nothing
  is guessed.

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
  Run enrollment family** and the relational filter shape of the count
  query (see [Mapped enrollment counts](#enrollment-counts-from-explicit-mappings)).

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

### Error codes

An operation refuses with Directus's error body, `{errors: [{message,
extensions: {code, …}}]}`; a Flow step records `{ok: false, stage, code,
message}`, and a Flow that relays a child's failure writes `<Subject>
failed [<stage> <CODE>]: <child message>`. The dashboard shows the code
(`Failed: <CODE>`, the last failure) and the message. Messages state facts
only (ids, counts, codes and places, never a value); this table says what
the codes mean and what to do. The coordinator's codes carry the prefix
`COORDINATION_`, the snapshot import's `SNAPSHOT_` and the export
operation's `EXPORT_`; a released claim's last failure keeps the bare
release code (`SOURCE_CHANGED`, `FINGERPRINT_CHANGED`,
`CLAIM_INTERRUPTED`, `CLAIM_ABANDONED`).

| Code | Meaning | What to do |
| --- | --- | --- |
| `UNAUTHENTICATED`, `SNAPSHOT_UNAUTHENTICATED`, `EXPORT_UNAUTHENTICATED`, `FORBIDDEN`, `SNAPSHOT_FORBIDDEN`, `EXPORT_FORBIDDEN` | The caller check refused the request (see [Access](#access)): `Authentication required` (401, no signed-in user) or `Forbidden` (403, the signed-in user lacks Directus's `admin` flag). | 401: send it with a session or a static token of that project. 403: send it as a user with the `admin` flag. |
| `COORDINATION_INVALID_OPTIONS`, `SNAPSHOT_INVALID_OPTIONS`, `EXPORT_INVALID_OPTIONS`, `PUBLISH_INVALID_OPTIONS` | A step's options were refused: `Invalid options: <path>: <reason>`. A history line over 2,048 bytes is refused here too (`Moodle user <id>: history line <n> bytes, max 2048`). | Shorten the line in the user's raw `Courses` history; otherwise take the Flow's template again (delete the Flow, run setup). |
| `SOURCE_CHANGED`, `FINGERPRINT_CHANGED` | A source edit or a Flow-graph change overtook the run; its output was discarded, not failed. | Nothing: the next tick runs it again. |
| `CLAIM_INTERRUPTED` | The claim stopped heartbeating (a restart) at these inputs for the first time. | Nothing: the next tick runs it again once. |
| `CLAIM_ABANDONED` | The claim stopped heartbeating again at the same inputs, or a publication claim did. | Find why Directus stopped (its log), then **Recalculate** a calculation or publish again. |
| `COORDINATION_CLAIM_MISMATCH`, `COORDINATION_OWNER_MISMATCH` | The claim token is not the current claim's (it was released or taken over), or the claim belongs to another Directus process. | Read the status: its last failure names the release. Otherwise wait for the other process's run. |
| `COORDINATION_DOMAIN_MISMATCH`, `COORDINATION_PAGE_UNPLANNED`, `COORDINATION_PAGES_MISSING`, `COORDINATION_COMPLETION_RACED` | A step acted for another claim domain, on a page the claim did not plan, or completed before every planned page was staged. The installed rows stay. | Take the Flow's template again if it was edited, then **Recalculate**. |
| `COORDINATION_PAGE_INCOMPLETE`, `COORDINATION_DUPLICATE_ROWS` | A page read left out planned Moodle users or named others, or held a row twice. | Take the page Flow's template again if its read step was edited, then **Recalculate**. |
| `COORDINATION_PAGE_OVER_BUDGET` | One Moodle user's history, or one legacy rule's page, is larger than a page may hold (`Moodle user <id>: Courses history <n> bytes, max <m> per page`). | Shorten that user's raw history at the source. |
| `COORDINATION_UNKNOWN_RULE_MODE` | A rule's mode is not a declared one (`Rule <id>: mode "…", expected …`). | Set the rule's mode to a declared mode. |
| `COORDINATION_WRITE_GUARDED` | A write to a derived, candidate or bookkeeping collection outside its writer (`Write refused: <collection> (<role>; writer: <writer>)`). | Edit the source collections; the derived rows follow. |
| `COORDINATION_OUTCOMES_INCOMPLETE`, `COORDINATION_UNKNOWN_FILE` | A publication completed without every declared file uploaded, or reported a file no export definition declares. | Publish again; take the publish Flows' templates again if they were edited. |
| `INDEX_FAILED`, `ENROLLMENTS_FAILED`, `LEGACY_COUNT_FAILED`, `MAPPED_COUNT_FAILED`, `LEGACY_ZEROS_FAILED`, `ZERO_FILL_FAILED`, `PAGE_PLAN_MISMATCH`, `LEGACY_PLAN_MISMATCH`, `INVALID_RULE_PAGE`, `COUNT_FAILED`, `INVALID_AGGREGATE`, `PLAN_FAILED`, `COMPLETION_REFUSED`, `DOMAIN_UNKNOWN`, `NO_RESULT` | A calculation step failed; the relayed message names each stage and code down to the step that failed (for example `Rule 7 (course 9 / academic year 2): pattern does not compile as a unicode regular expression (…)`). The installed rows stay and the domain waits. | Correct what the innermost message names (here the rule's pattern), then **Recalculate**. |
| `SNAPSHOT_FILE_INVALID` | The file is missing, outside the **Moodle snapshots (private)** folder or local storage, or larger than `FINKI_HUB_SNAPSHOT_MAX_BYTES`. | Upload the CSV into that folder, or raise the limit. |
| `SNAPSHOT_INVALID_CSV`, `SNAPSHOT_INVALID_HEADERS`, `SNAPSHOT_INVALID_ROWS` | The file is no strict CSV, its header is not the 38 scraper fields, or its rows break the row rules (ids, `Name`, row count). | Correct the file and import again. |
| `SNAPSHOT_EMPTY_NOT_CONFIRMED`, `CONFIRMATION_REQUIRED` | An empty snapshot without **Allow an empty snapshot**, or a run without **Replace the whole active Moodle snapshot**. | Switch the box on (the empty one only to remove every Moodle user). |
| `SNAPSHOT_IMPORT_RUNNING`, `SNAPSHOT_PROMOTION_RUNNING`, `SNAPSHOT_CLAIM_BUSY` | Another import, promotion or claim holds the snapshot. | Wait until it ends; a dead import is taken over after `IMPORT_TIMEOUT` plus 60 seconds. |
| `SNAPSHOT_IMPORT_TIMEOUT` | Staging took longer than `IMPORT_TIMEOUT`. | Raise `IMPORT_TIMEOUT` for Directus, then import again. |
| `SNAPSHOT_NOT_READY`, `IMPORT_NOT_READY`, `SNAPSHOT_STAGING_CHANGED`, `SNAPSHOT_FINGERPRINT_MISMATCH`, `SNAPSHOT_COUNT_MISMATCH`, `SNAPSHOT_ACTIVE_CHANGED`, `SNAPSHOT_CLAIM_LOST` | The staged or active rows changed between two steps, or the claim was lost; nothing was replaced. | Import again. |
| `SNAPSHOT_BACKUP_FAILED` | The backup of the active users could not be written or verified; nothing was replaced. | Check the local storage (space, permissions), then import again. |
| `SNAPSHOT_IMPORT_FAILED`, `SNAPSHOT_PROMOTION_FAILED` | An unexpected fault; the Directus log names the database object. | Read the log, then import again. |
| `EXPORT_NOT_READY` | Readiness has blockers (`Not ready: source revision <n>, blockers: <code> <count>, …`). | Clear the blockers (the **Readiness** panel links their records), then publish. |
| `EXPORT_UNSTABLE_PREPARATION` | The source or the accepted calculation moved while the files were prepared, or since the claim. | Publish again once the edits and calculations have settled. |
| `EXPORT_UNRESOLVED` | The projection cannot resolve a value: a missing count, two links of one generation, an assignment without a role or a staff name, an Active course without a professor (`Course 12: professor missing`), a course status outside its three values. | Correct the rows the ids name. |
| `EXPORT_INVALID_PAYLOAD` with `required key <key> missing` | A row of the named file lacks a key its consumers read on every row, or holds it empty (see [Publishing](#publishing)). | Fill in that value of the row. |
| `EXPORT_INVALID_READ`, `EXPORT_INVALID_PAYLOAD`, `EXPORT_INVALID_DEFINITION` | A read answered another shape, a file row breaks its definition, or the export definitions or readiness registry are inconsistent. | A code or schema fault: run `npm run setup`, and report the message if it stays. |
| `PUBLICATION_NOT_CLAIMED` | `busy`: another run holds the claim; `upstream_dirty`: the calculations are pending; `nothing_pending`: publication is current. | Wait; wait for the calculations; mark publication pending (**Recalculate**) to publish the current files again. |
| `PUBLICATION_PARTIAL`, `PUBLICATION_FAILED`, `PUBLISH_UPLOAD_FAILED`, `PUBLISH_FAILED` | Some or no declared files were uploaded (`Uploaded <n> of <m>; failed: …. First failure: …`); a file whose failure carries no code of its own is listed as `PUBLISH_FAILED`. | Correct the upload cause (bucket, credentials, network), then publish again. |
| `PUBLICATION_CLAIM_FAILED`, `PUBLICATION_NOT_PREPARED`, `PREPARATION_REFUSED`, `PUBLICATION_LOOP_FAILED`, `PUBLISH_LOOP_FAILED`, `PUBLICATION_OUTCOMES_REFUSED`, `OUTCOMES_REFUSED`, `PUBLICATION_NOT_RECORDED` | A step of the publication failed; the relayed message names the child's code and message. `PREPARATION_REFUSED` is the publication's last failure when the preparation refused (its message is the `EXPORT_*` refusal, such as `Not ready: …`). | Correct what that message names, then publish again. |
| `MARK_REFUSED` | The coordinator refused the mark (the message names why). | Correct the chosen domains, then run **Recalculate** again. |
| `RULES_SCOPE_INVALID`, `RULES_SCOPE_UNKNOWN`, `RULES_READ_FAILED` | **Add enrollment rules** got no valid scope, a year or course that does not exist, or could not read the pairs. | Pick an existing academic year, course or pair. |
| `RULES_BATCH_FAILED` | A batch failed (`Batches failed: <i>/<n> (<CODE>, <k> rules); rules created: <n>`); the batches before it stay. | Run it again: existing pairs are skipped. |

## Access

Directus has REST and GraphQL APIs, but this setup grants no anonymous
access: no command creates a public permission, every collection is
private, and the only public output is the declared files in the R2
bucket.

- `/finki-hub-data-operations/*` (status, snapshot report, the setup
  migrations), `GET /finki-hub-data-status` and
  `/finki-hub-data-status/readiness`, and the snapshot and export
  operations run one caller check first (`src/access.ts` of the
  data-operations bundle): 401 `UNAUTHENTICATED` (`Authentication
  required`) without a signed-in user, 403 `FORBIDDEN` (`Forbidden`) when
  the caller's Directus accountability lacks the `admin` flag. The
  operations answer the same refusals with their prefix
  (`SNAPSHOT_UNAUTHENTICATED`, `SNAPSHOT_FORBIDDEN`,
  `EXPORT_UNAUTHENTICATED`, `EXPORT_FORBIDDEN`).
- The status answer is a bounded view (states, codes, counts, names, links
  and the last failure's message; no fingerprint, claim owner or record).
- The Search endpoints (`/finki-hub-course-history/options`, `/search`)
  refuse a request without a signed-in user (403 `FORBIDDEN`) and run as
  the signed-in user.

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
- The page header's native search and filters apply too (the layout reads
  `Filtered by page header: search, filter`), including filters on
  related fields such as **History Memberships → Entry → Label** or the course
  of an entry's mappings. They run as the signed-in user. A filter path names
  at most `MAX_RELATIONAL_DEPTH` fields (10 by default, as for the REST API).
  A longer path, `_some`/`_none` quantifiers and implicit `$FOLLOW(...)`
  relations are refused with `400 INVALID_PAYLOAD` and the reason, which the
  layout shows as `Search failed: HTTP 400 INVALID_PAYLOAD: Invalid criteria:
  filter: <reason>` (for example `path exceeds 10 fields` or `unsupported key
  _some`). A failed read of the choices reads `Course list failed: …`, a
  caller the endpoint refuses `… HTTP 403 FORBIDDEN`. Course
  selections are temporary and reset when the layout is reopened; they are not
  saved bookmarks.

Search works on the raw histories. Choices come from the current imported
Moodle histories, never from the history-entry table. Matching is
case-sensitive against complete newline-separated entries of the raw
`Courses` text, including year/semester, not substrings or regex; it does
not go through the history index or the mappings, so a line that is
unmapped, ignored or not indexed yet is found like any other. To reach the
mappings of a person's lines, open the person: the **History Memberships**
list shows each line with its review state and the course and academic year
of its mappings. Up to 20 selections are supported per group. Use **Refresh
data** after importing a new snapshot to reload choices and results. Both
private endpoints read as the signed-in user; no collection data is
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
existing branding file IDs are reused. It needs a running Directus and a
static token. Unlike the lifecycle commands, it reads `.env`: it takes
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
dashboard, the Flows and the tests) derives from that declaration. What is
added in Studio is a row; what changes the public contract, the
correctness boundary or the Flow graph is one code declaration. The
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
4. Set `published`. `courses.json` gains exactly one key per course, the
   year's label, among the other year keys newest first; readiness blocks
   until every course has a count for it and its `sort` is unique.

No event Flow creates rules on its own; readiness warns about mappings
without a rule (`mapping_without_rule`) and blocks a published pair without
one (`enrollment_rule_missing`).

### A curriculum generation or study program

1. Create the `curriculum_generations` row (`code`, `label`,
   `has_curriculum`, `sort`), then its `study_programs` rows (`generation`,
   `code`, `name`, `description`, `sort`). Both stay unpublished.
2. Create the generation's `curriculum_entries` and their program states
   (the program picker offers only the generation's programs). A code
   starts with `F`, two digits (the generation's), `L` and the level, as in
   `F28L1W001`: the database refuses a non-empty code without that start,
   so codes of another scheme need `codeLevel` (`exports/curriculum-code.ts`)
   and its guard (`curriculum-guards.ts`) changed first. Link courses in
   the course form's **Curricula** list, and add equivalency members of the
   generation where they apply. Browse them with **Curriculum by
   generation** narrowed by the Generation filter; the Needs review views
   show the new rows too. No bookmark and no setup rerun is needed.
3. Publish the generation: `courses.json` gains its `<code>-available` key
   and its block, laid out like 2023 (states before credits), newest first
   by `sort`. Publish each program: it adds its `<code>-state-<program>` key
   in program `sort` order. Unpublishing removes the keys again.

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
  `test/fixtures/expected-exports` do. A key or keyed entry with
  `required: true` is one a consumer reads on every row: a row without it
  refuses the file. The map is the file's whole allowlist: no other key
  can be published;
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
caller check, explicit fields, events off, every nested list read whole
rather than cut to `QUERY_LIMIT_DEFAULT`), serializes the rows in
id order with the value rules, and validates every payload against its
definition (`exports/file-check.ts`: a list of one object per read row,
only declared keys and in their order, every required key, non-empty text
values, the size bound) before anything is answered.

To change a file or add one:

1. Edit the file's definition module, or add a new module and append it to
   `exports/index.ts`. Declare every read with explicit fields and every
   key with its rule. When the file needs data that must be complete
   first, add a readiness check that gates it (below).
2. Update the expected output in the tests: `test/relational-export.test.ts`
   compares today's declared files as data with the files committed under
   `test/fixtures/expected-exports` (`test/expected-exports.ts` reads
   them), and `test/export-definitions.test.ts` shows a new definition end
   to end. The comparison pairs rows by a match key (courses and staff by
   `name`, rooms by `location` and `name`, students by `index`) and pins
   every value in its exact text, each row's keys, the rows themselves and
   the key set listed in `keys/<file>.json`. Bytes, digests, layout, key
   order and row order are not compared; the engine's own tests cover
   them. `keys/courses.json` keeps the declared key order, which the
   key-position tests in `test/public-assets-contract.test.ts` read.
   Edit the expected values by hand, in 2-space JSON; never
   regenerate them from the engine. A case whose rooms, staff and students
   equal the parity case's holds only its `courses.json`.
3. `npm run build:operations`, then restart Directus.

No Flow, no schema change and no Studio edit is involved: the publication
Flows only call the export operation, which serves every definition, and
**Publish / Public assets** uploads whatever the definitions declare, one
file after another in the listed order, recording one outcome per file.
The dashboard lists the new file from the declarations.

### A readiness check

Add one entry to `exports/readiness-registry.ts`: its code, severity, the
source of its count (a plain-filter aggregate over one collection, or a
check counted in code), the files it gates (a blocker gates at least one,
a warning none), whether its records carry a `generation` column, a
description (the tooltip of its code: a short fact without a trailing
period, with no instruction; the table under
[Readiness and Needs review views](#readiness-and-needs-review-views) says
what to do) and, when a plain filter lists its records, a review view
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
pick it. No code changes and no rebuild. It must be set up like the
installed ones, or the panel does not run it and shows the first rule it
breaks as `Not runnable: <rule>`:

| Panel line | Set in the Flow |
| --- | --- |
| `Not runnable: trigger not manual` | **Trigger**: Manual. |
| `Not runnable: name without a "Data / " or "Publish / " prefix` | A name that starts with `Data / ` or `Publish / `. |
| `Not runnable: Flow inactive` | **Status**: Active. |
| `Not runnable: no collection`, `Not runnable: collections must be exactly data_operations` | **Collections**: `data_operations` only. |
| `Not runnable: requires item selection` | **Collection Page (Requires Selection)** off. |
| `Not runnable: requires Asynchronous off and Error on Reject on` | **Asynchronous** off and **Error on Reject** on. An asynchronous Flow answers before it runs and a Flow without Error on Reject answers success after a failed step, so the panel could not tell a failure from a finished run. |

One more rule is the Flow's own: the dialog fields are yours, but the API
ignores them, so validate every input inside the Flow.

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
statement-level invalidation trigger and, for a derived or candidate
collection, its write guard. Then:

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
**Courses** sheet (`src/specs/private.ts`) is the scraper's CSV imported
into Google Sheets: it carries every field of the table under its own
header, read with the table's kind, and `ID_old` and `ID_new` follow the
snapshot import's id rule (`isPositiveId`, unique within the column). A new
scraper column (a change of the scraper's output) is a change of that table
only, followed by `npm run build:operations`, a restart and
`npm run setup`, never an import option; a workbook exported before the
change lacks the column, and the one-time import stops at its header.

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
| `npm run compare:live` | Compares what a fresh import of a workbook would publish with the live `courses.json`, `staff.json` and `rooms.json`; a manual check before a cutover, never part of `npm test` (see [Comparing with the live files](#comparing-with-the-live-files)). |

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
- `DIRECTUS_SEARCH_TEST_TOKEN`: a static token of that project;
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
| `npm run test:search` | `test/search.integration.mjs` and `test/search-relational.integration.mjs`: Search over generated users and the relational filters. | nothing |
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

### Back to marker-only after a manual run

The suites set the model up and tear it down themselves. After using the
test project by hand (setup, an import, a publication or a snapshot
replacement), return it to marker-only before the next suite, or the
suites refuse it:

1. Delete every file of the `publish` storage location
   (`GET /files?filter[storage][_eq]=publish`; deleting the file deletes
   its bucket object) and every file of the **Moodle snapshots (private)**
   folder (the snapshot CSVs and their backups). The folder stays.
2. Tear the model down with `destroyDataModel` of
   `test/relational/data-model-helpers.mjs`, which removes the **Data
   operations** dashboard, the declared presets, the model collections and
   the sidebar folders. With the four target variables set:

   ```sh
   node --import tsx --input-type=module -e "
   import { assertMarkerPresent, targetFrom } from './test/isolated-target.mjs';
   import { destroyDataModel } from './test/relational/data-model-helpers.mjs';
   const target = targetFrom(process.env);
   await assertMarkerPresent(target);
   await destroyDataModel(target);"
   ```

3. Check the state: `GET /collections` lists the marker collection and no
   model collection, `GET /files`, `/presets`, `/dashboards` and
   `/panels` answer no row, every managed Flow is still installed and
   **Data / Process pending** is active. Remove any user or role you added
   by hand too.

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
   added) and tear the model down to marker-only (see
   [Back to marker-only after a manual run](#back-to-marker-only-after-a-manual-run)).

### Comparing with the live files

`npm run compare:live` shows what a fresh import of a workbook would change
in the files consumers read today. It never contacts Directus and writes
nothing; the workbook is named on the invocation, with no default:

```sh
WORKBOOK_PATH=finki-hub.xlsx npm run compare:live
```

1. It reads the workbook and runs the import's own check. A workbook the
   import would refuse stops it as the dry run stops (exit code 3).
2. It holds the planned rows in memory as a fresh import would write them
   and runs the export engine over them, as publishing does. Counts are not
   derived there: every count is 0, so the year keys of `courses.json` are
   not compared and are listed under `notCompared`.
3. It fetches `courses.json`, `staff.json` and `rooms.json` from
   `https://assets.finki-hub.com/` into memory, 30 s at most per file.
   `students.json` is never fetched.
4. It prints one JSON document: `workbook` (the path read), then per file
   the rows on each side and the rows matched (`rows`), the rows on one
   side only (`onlyLive`, `onlyProjected`), the rows whose match key
   repeats on either side, which are not compared (`duplicateKeys`), the
   number of differing values (`differingValues`), and per differing key
   where its value differs, is live only or is projected only (`keys`). A
   course and a staff member are matched by name, a room by location and
   name.

The output holds course names, keys, counts and workbook places only. For
`courses.json` it lists the course names per key, never a professors or
assistants text; a compared year key lists each course with both counts.
For `staff.json` and `rooms.json` it gives counts, and each projected row
without a live partner by its workbook place (`Кадар (Export) row 61`),
never a staff or room value.

| Code | First stderr line | Meaning |
| --- | --- | --- |
| 0 | none | Compared. Differences are reported on stdout, never as a failure. |
| 1 | `Live check failed: <reason>` | The workbook cannot be read, the projection is refused (`staff.json row 12: required key title missing`), or a live file failed (`courses.json: HTTP 503`, `staff.json: unexpected response: <path>: <message>`, `rooms.json: timed out after 30 s`). |
| 2 | `Live check refused: WORKBOOK_PATH not set` | No workbook named, or an argument given. |
| 3 | `Live check blocked: <n> cases` | The cases the dry run reports, one `- [<code>] <place>: <fact>` line each; see [One-time workbook import](#one-time-workbook-import). |
