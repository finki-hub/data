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
| New, empty project | `npm run setup` | Installs the current data model, its database constraints and source-invalidation triggers, the Studio presentation, a table view per checkpoint collection, the **Search** bookmark, the Moodle history index Flow templates, the private File Library folder **Moodle snapshots (private)**, the **Data / Import Moodle snapshot** Flow template, the mapped and legacy enrollment count Flow templates and the automatic processing Flows (**Data / Process pending**, **Data / Mark pending**, **Data / Count enrollments**; see [Automatic processing](#automatic-processing)). Writes no records, but once it has run the schedule keeps the derived data current on its own. |
| New project, first data from the spreadsheet | `npm run import` | Refuses unless every application collection is empty and no checkpoint Rebuild or Publish Flow exists under another id, runs setup, then imports the workbook once (below). |
| Project that already holds data | `npm run migrate -- --dry-run --report <private path>`, then `-- --apply` | Upgrades it in place to the relational model through the migration ledger. Never reads the workbook. |

Setup is idempotent and install-once: rerunning it creates only what is
missing. A preset (default view or bookmark) or Flow that already exists is
never changed, whoever created it, so column choices, filters and Flow
settings edited in Studio survive every rerun. Repository Flow definitions
are templates with stable ids, not a source of truth. To take a newer
template of a Moodle history index or automatic processing Flow, delete
that Flow in Studio and run setup again. This does not work for **Rebuild derived data** and **Publish
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
setup` creates, including its coordination status row, is accepted. It also
refuses a project that holds a Flow running the checkpoint derivation or
publication (an operation of type `finki-hub-rebuild-derived-data` or
`finki-hub-publish-json`) under an id other than the import's own, for
example an emptied old deployment, instead of installing a second **Rebuild
derived data** and **Publish public assets** beside it; the message lists
those Flows. On an accepted project it:

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

A whole Moodle snapshot replaces the active one through the controlled
import, which administrators run from Studio. The native **Import / Export**
sidebar of **Moodle Users** is not supported for snapshots: it upserts rows
by the generated `id`, drops empty cells, parses JSON-looking text, accepts
structurally malformed rows and replaces nothing atomically.

1. Run `courses-scraper` normally to produce `profiles.csv`: the 38 headers
   of the scraper contract, in any order, and no `id` column.
2. Upload `profiles.csv` into the **File Library** folder **Moodle snapshots
   (private)**, which `npm run setup` creates. It stays a private file in the
   local storage location. The import refuses a CSV outside that folder, so
   one permission filter on the folder keeps every snapshot file and backup
   away from any role that may read files. Copy the file's id from its
   address.
3. Open the hidden **Data Operations** singleton (Content → Operations with
   hidden collections shown, or `/admin/content/data_operations`) and run
   the Flow **Data / Import Moodle snapshot** from its sidebar. Paste the file id and switch on **Replace the whole active
   Moodle snapshot**. Switch on **Allow an empty snapshot** only to remove
   every Moodle user on purpose.

The Flow first stages the file into the hidden staging collection in one
transaction and answers only once it committed. The file must be strict CSV
with exactly the 38 field names; an empty line between rows is refused,
empty lines at the end are ignored. Every value is kept exactly as written,
`Name` is required, and a populated `ID_old` or `ID_new` must be a positive
id that is unique within its own column. A history line longer than 2,048
bytes is staged unchanged and reported, because the history index will
refuse that user until the line is shortened. The Flow then writes a private
backup CSV of the current Moodle users (`moodle-users-backup-<time>.csv` in
the same private folder) and verifies it. Finally it replaces the active users in
one database transaction under the coordinator's exclusive claim. A refused
file or a failed step changes no active row. Course mappings, history
entries and every other collection are never touched. The history
memberships are cleared, and the history index, the enrollment counts and
publication become pending: the schedule rebuilds the index and then the
counts on its own (see [Automatic processing](#automatic-processing)). To
restore the previous snapshot, run the same Flow with the backup file. Deleting old backups is a manual File Library task.

The import is bounded by `IMPORT_TIMEOUT` (15 minutes in `compose.yaml`) and
by `FINKI_HUB_SNAPSHOT_MAX_BYTES` (256 MiB unless set). For administrators,
`GET /finki-hub-data-operations/snapshot` reports the import state, the
staged and active row counts with their fingerprints, the backup, the last
error, the snapshot the last promotion made active, and whether the active
rows still equal it (`activeMatchesPromotion`, false after an edit outside
this workflow, whatever later imports did). A failed run logs its code and
the database object involved, never a value, to the Directus log.

Until the cutover retires it, the checkpoint **Rebuild derived data** still computes the old calculated course fields: after promoting a new snapshot, also run it from the Flows action in any affected source collection. The relational enrollment counts need no button. Publishing to R2 remains a separate explicit action.

## Enrollment counts from explicit mappings

`npm run setup` installs two operation-triggered Flow templates that count
the course/year pairs whose enrollment rule has the mode `mapped_entries`:

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

Only the enrollment claim's completion writes `course_enrollments`, and it
replaces every row at the claimed revision, so one claim must stage both
rule families (see the next section). **Data / Count enrollments** is the
Flow that does so under the claim the schedule takes (see
[Automatic processing](#automatic-processing)). The coordinator
refuses `plan_pages` with source `rules` under an enrollments claim while
any rule is not `mapped_entries`, and source `history` under any claim but
a history index claim (`DOMAIN_MISMATCH`), so an enrollments claim is
never completed from a plan that leaves the legacy family out.
Both templates contain a coordinator step, so an edit to either of them in
Studio marks every calculation pending again. The count query filters with
the path `history_memberships.entry.mappings` and puts the course and the
year side by side in that path. Keep that shape when you edit the query in Studio:
Directus ignores a `_some` block that holds two conditions, and two separate
`_some` blocks can match the course of one mapping with the year of
another.

Both Flows log activity only (no data chain is stored). Directus writes one
`run` activity row for every Flow run, so an enrollment run adds one row per
mapped rule and one per page (256 for 254 rules on two pages), besides the
row of the Flow that started it. Directus 12.3.1 prunes these rows only when
`RETENTION_ENABLED` is `true`; run rows then follow `FLOW_LOGS_RETENTION`
(90 days by default). The Compose file leaves retention off.

## Enrollment counts from legacy rules

Every existing course/year is seeded by the migration as a `legacy_regex`
rule with the pattern text the checkpoint compiled (a last-id override of
`course_enrollment_patterns`, else the literal `<course name>-<year>`). The
pattern stays editable in **Course Enrollment Rules**; no Flow and no
extension interprets it except the count script below, which applies it
exactly like the checkpoint did: `new RegExp(pattern, 'u')` over the whole
raw `Courses` history, tested once per user. Names are not escaped, so a
pattern may cross line boundaries, and a pattern that does not compile
(for example the default of a course named `C++ Course`) fails the run.

`npm run setup` installs three operation-triggered templates:

- **Data / Count legacy enrollments** takes `{claim}`. It reads the plan the
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

`plan_pages` with source `enrollments` plans both families in one plan of
an enrollments claim: the mapped pages first, then per legacy rule page
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

The dry-run of `npm run migrate` also writes a conversion proposal into the
private report (`mappingProposal`): for every legacy rule whose course/year
has explicit entry mappings it compares the set of Moodle user ids the
pattern matches with the set the mappings match, and for every superseded
duplicate pattern row the set that row would match, with counts and at most
five sample user ids per difference. Each expression runs over the
histories with a deadline of 10 seconds; one that runs out is reported as
`timedOut` (never equal) instead of holding the dry-run. It never changes
a rule; switch a rule to `mapped_entries` in Studio only where the sets
are equal, and keep `legacy_regex` where an expression needs several
entries at once. The printed summary carries the counts only.

## Automatic processing

The history index and the enrollment counts refresh on their own; nobody
has to press a button after an edit. `npm run setup` installs three Flows
for this, beside the history and enrollment templates above:

- **Data / Process pending** runs on a native Directus schedule every 15
  seconds (cron `*/15 * * * * *`; the seconds field comes first, so
  `0 */15 * * * *` would mean every 15 minutes). Each tick asks the
  coordinator for the first pending calculation: the Moodle history index
  first, the enrollment counts after it, never publication, which stays
  for the publish Flow. When nothing is pending, when another run holds the
  claim, when a long source transaction holds the status row for more than
  2 seconds, or when the pending work failed at its current inputs, the
  tick ends at once. It reads the coordination status row and the Flow
  graph, never a collection. When it claims, it runs exactly one domain, through
  **Data / Refresh history index** (every history page in turn, then the
  completion) or **Data / Count enrollments** (one plan of both rule
  families, the mapped pages in turn, a heartbeat, the legacy pages and
  their explicit zeros, then one completion that installs every pair). The
  next tick takes the next domain.
- **Data / Mark pending** is a manual Flow on the hidden **Data Operations**
  singleton for administrators. It marks the chosen domains pending (the
  history index and the enrollment counts when none is chosen) and answers
  the status. It runs nothing itself: the schedule picks the work up at its
  next tick. It is also the explicit retry of a failed run.
- **Data / Count enrollments** and **Data / Refresh history index** run
  under a claim their caller holds and never claim themselves.

Every edit of a source collection marks its domains inside the edit's own
database transaction (the statement triggers of `npm run setup`), so a
rolled-back edit marks nothing and a committed one is never missed. A
Moodle user marks the history index, the counts and publication; entries,
mappings, rules and academic years mark the counts and publication; every
other source collection, including the checkpoint enrollment overrides,
marks publication. The mark covers the whole domain, so a mapping or rule
moved to another course or year, or deleted, changes both the old and the
new pair; a deleted mapping leaves its rule, whose pair is then counted as
0. Deleting an entry or editing its label by hand (the label belongs to
the index) marks the history index too. Each calculation also keeps the
revision of the last statement that touched its inputs
(`history_index_input_revision`, `enrollments_input_revision`; a Moodle
user touches both, an entry, mapping, rule or academic year the counts):
an edit of a room, staff member, course or any other publication-only
collection never discards a running calculation or retries a failed one. A change to a managed Flow (its
trigger, an operation's type, options or edges, in any Flow that holds a
coordinator step or that such a Flow reaches through a Trigger Flow step)
marks both calculations; a name, description, icon, position or status
does not.

A change reaches `course_enrollments` within one interval plus the run: on
the fixture, 13 to 15 seconds after an edit, of which the count run took
about 0.2 seconds (7.3 seconds with 450 mapped rules). An edit of a Moodle
history needs two ticks, the index and then the counts. Nothing is pushed
to an open page: refresh it. Fifty edits between two ticks cost one run.

When a run fails (for example a legacy pattern that does not compile), the
installed counts stay, the domain stays pending, and the status keeps the
failure's code and message (ids only). The schedule does not retry it on
later ticks: an edit of a collection the calculation reads, **Data / Mark
pending** or a change to the Flow graph lets the next tick run it again. A
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
claim is always `CLAIM_ABANDONED`.

`GET /finki-hub-data-operations/status` (administrators) reports each
domain under `domains` with `state` (`current`, `pending`, `running` or
`failed`), `current`, and `waitingFor`, the pending domains it runs after.
A failed or interrupted history run leaves `history_index` not current:
its index is stale until a run completes. `lastError` keeps the last
failure with its code, message and source revision after later successes;
its `blocking` flag says whether it still holds its domain back.
`revisions.inputs` shows each calculation's input revision. The message
and the input revisions are stored in new columns (`last_error_message`,
`history_index_input_revision`, `enrollments_input_revision`), so run
`npm run setup` before the rebuilt data-operations extension starts; until
a statement writes an input revision, the source revision stands in.

Each tick writes one `run` activity row (about 5,760 a day), like every Flow
run that logs activity; only `RETENTION_ENABLED=true` with
`FLOW_LOGS_RETENTION` prunes them. Without `SYNCHRONIZATION_STORE=redis`,
every Directus process fires every tick; the coordinator's claim lets one
of them run. The Task 9 manual runner **Data / Rebuild Moodle history
index** is no longer a setup template: a project that ran an earlier setup
keeps it, and it should be deleted in Studio. The checkpoint **Rebuild
derived data** Flow and its extension stay untouched until the cutover.

When the first non-administrator role is created, it must not hold what
`src/editor-policy.ts` forbids: create, update or delete on
`moodle_users` (the native CSV import needs them; snapshots go through
**Data / Import Moodle snapshot**), any write to the staging, index,
count, coordination and migration ledger collections, and any write to
Flows, operations, permissions, policies or their assignments (the
managed Flows read and write with `$full`, the schedule without
accountability, so editing one would lift every other rule). Administrators cannot be restricted
that way; `snapshotReadiness` in the same file flags active Moodle users
changed outside the snapshot workflow (the snapshot status's
`activeMatchesPromotion`).

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
