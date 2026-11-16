<project_context>
## FINKI Hub data

This instance is the source of truth for FINKI Hub: courses and the 2013/2018/2023 curricula, staff, rooms, the dean's office, Discord channels, exam sessions, Anto quotes, students and the Moodle course-history snapshot. The public API and the `/legacy/*.json` files are built from it live, so an edit is public within a minute.

- Names are Macedonian (Cyrillic). Keep them exactly as stored; don't transliterate or translate them unless asked.
- **Private data**: `students` (only student council members are public), `moodle_users`, `moodle_import_rows` and the files in "Moodle snapshots (private)". Read them only when the request needs them, show only the fields asked for, and never export them.
- **Derived data** (`moodle_course_entries`, `moodle_history_memberships`, `moodle_counted_lines`, `course_enrollments`, `data_operation_matches`) is rebuilt by Flows and the database refuses other writes: don't edit it. To recompute, run the **Data / Mark pending** Flow. Don't edit `data_operations`.
- **Timetable data** (`timetables`, `timetable_lessons`, `timetable_slots`, `timetable_slot_staff`, `course_teaching`) comes from the **Data / Import timetables** Flows and the database refuses other writes. Who teaches a course is `course_teaching`; to fix a wrong or missing match, add a row to `course_aliases` or `staff_aliases`, never edit the derived rows. `courses.json` publishes the staff of the six latest main timetables (`timetables.recent`), else `course_accreditation_staff`, else `teaching_assignments`. Where and when a course is held is `timetable_slots` (day, starts, ends, room), and who holds each slot is `timetable_slot_staff`; fix a wrong or missing room match with a `room_aliases` row.
- **Theses** (`bachelor_theses`, `master_theses` and their staff tables `bachelor_thesis_staff`, `master_thesis_staff`) come from the **Data / Import theses** Flows, which replace them all on every run; the database refuses other writes. A staff member's mentorships and committee work are the two staff tables; a committee name matches staff like a timetable teacher, so fix a wrong or missing match with a `staff_aliases` row.
- **The schema lives in code** (the `finki-hub/data` repository, installed by `npm run setup`): don't create or change collections, fields, relations, Flows or permissions unless explicitly asked, and then say the change will drift from the code.
- Before changing more than 5 items, list them and ask.
- Enrollment counts come from the Moodle history through pattern and explicit mappings: to change a count, change a mapping, never the count.
</project_context>
