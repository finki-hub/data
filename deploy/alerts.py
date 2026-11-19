#!/usr/bin/env python3
"""Discord alerts for the FINKI Hub Directus deployment.

  alerts.py send <message>   post one message
  alerts.py watch            check once and alert on what changed:
    - a failed data operation (enrollment counts, history index; a run that
      was only overtaken by a newer edit and reran is not a failure)
    - a failed Moodle snapshot import
    - the Directus container not healthy
    - /legacy/courses.json not answering 200
    - names in the published timetables that match no course, staff member
      or room
      (each posted once, when it first appears)
    - Moodle courses that are not counted although their name starts with a
      course's name, English name or alias (a pattern that misses a new
      spelling or an English group); posted once each, when it first appears
    - the timetable import not succeeding for over a day
    - the thesis import not succeeding for over a day

The webhook URL is read from /root/directus/alerts.env (DISCORD_WEBHOOK_URL)
and never printed. The last seen state lives in /var/lib/directus-alerts, so
each problem is posted once when it starts and once when it is resolved.
"""
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

ENV = pathlib.Path("/root/directus/alerts.env")
STATE = pathlib.Path("/var/lib/directus-alerts/state.json")
OVERTAKEN = {"SOURCE_CHANGED", "FINGERPRINT_CHANGED"}
# Uncounted Moodle courses named like a course: label, then the course whose
# name, English name or alias is the longest prefix of it.
MOODLE_UNCOUNTED = r"""
with names as (
  select id, lower(name) n from courses
  union select id, lower(name_en) from courses where name_en is not null
  union select course, lower(name) from course_aliases
)
select e.label, c.name
from moodle_course_entries e
join lateral (
  select names.id from names
  where length(names.n) >= 6
    and starts_with(lower(regexp_replace(e.label, '\s+', ' ', 'g')), names.n)
  order by length(names.n) desc limit 1
) best on true
join courses c on c.id = best.id
where e.label ~ '\d{4}'
  and not exists (select 1 from moodle_counted_lines l where l.entry = e.id)
  and (select count(*) from moodle_history_memberships m where m.entry = e.id) >= 5
order by e.label
"""
LEGACY = "https://data.finki-hub.com/legacy/courses.json"
# The daily import runs at 04:30; a day plus two hours of slack.
TIMETABLE_STALE_SECONDS = 26 * 3600
# The daily thesis import runs at 05:00; every success sets imported_at.
THESES_STALE_SECONDS = 26 * 3600


def webhook() -> str:
    for line in ENV.read_text().splitlines():
        if line.startswith("DISCORD_WEBHOOK_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("DISCORD_WEBHOOK_URL missing in alerts.env")


def send(message: str) -> None:
    body = json.dumps(
        {"content": message[:1900], "allowed_mentions": {"parse": []}}
    ).encode()
    request = urllib.request.Request(
        webhook(),
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "finki-hub-alerts"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        response.read()


def sql(query: str) -> str:
    return subprocess.run(
        ["docker", "exec", "directus-db-1", "psql", "-U", "directus", "-d",
         "directus", "-AtF", "\t", "-c", query],
        capture_output=True, text=True, check=True, timeout=60,
    ).stdout.strip()


def container_health() -> str:
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Health.Status}}", "directus-directus-1"],
        capture_output=True, text=True, timeout=30,
    )
    return result.stdout.strip() or "missing"


def legacy_status() -> int:
    try:
        request = urllib.request.Request(LEGACY, headers={"User-Agent": "finki-hub-alerts"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def check_operations(state: dict) -> list[str]:
    """The last data operation failure and the last snapshot import error."""
    row = sql(
        "select coalesce(last_error_at::text,''), coalesce(last_error_code,''), "
        "coalesce(last_failed_domain,''), "
        "left(regexp_replace(coalesce(last_error_message,''), '\\s+', ' ', 'g'), 300), "
        "coalesce(import_error,''), coalesce(import_finished_at::text,'') "
        "from data_operations order by id limit 1"
    )
    if not row:
        return []
    messages = []
    error_at, code, domain, message, import_error, import_at = (row.split("\t") + [""] * 6)[:6]
    if error_at and error_at != state.get("error_at") and code not in OVERTAKEN:
        messages.append(
            f"⚠️ **Directus data operation failed** ({domain or 'unknown'}): "
            f"`{code}` {message}".strip()
        )
    state["error_at"] = error_at
    import_key = f"{import_at}|{import_error[:100]}"
    if import_error and import_key != state.get("import"):
        messages.append(f"⚠️ **Moodle snapshot import failed**: {import_error[:300]}")
    state["import"] = import_key
    return messages


def check_health(state: dict) -> list[str]:
    """The health of the container and of the public files."""
    messages = []
    health = container_health()
    if health != state.get("health", "healthy"):
        messages.append(
            "✅ Directus is healthy again" if health == "healthy"
            else f"🔴 **Directus container is {health}**"
        )
    state["health"] = health

    status = legacy_status()
    was_ok = state.get("legacy", 200) == 200
    if (status == 200) != was_ok:
        messages.append(
            "✅ /legacy answers again" if status == 200
            else f"🔴 **{LEGACY} answers {status or 'nothing'}**"
        )
    state["legacy"] = status
    return messages


def check_timetable_names(state: dict) -> list[str]:
    """Names in the published timetables (the ones courses.json reads) that
    still match nothing, each posted once."""
    rows = sql(
        "select 'subject', l.subject from timetable_lessons l "
        "join timetables t on t.id = l.timetable "
        "where t.recent and l.course_match = 'unmatched' "
        "union select 'teacher', l.teacher from timetable_lessons l "
        "join timetables t on t.id = l.timetable "
        "where t.recent and l.teacher_match = 'unmatched' "
        "union select 'room', s.classroom from timetable_slots s "
        "join timetables t on t.id = s.timetable "
        "where t.recent and s.room_match = 'unmatched' order by 1, 2"
    )
    unmatched = rows.splitlines() if rows else []
    known = set(state.get("unmatched", []))
    new = [line for line in unmatched if line not in known]
    state["unmatched"] = unmatched
    if not new:
        return []
    names = ", ".join(
        f'{kind} "{name}"' for kind, name in (line.split("\t", 1) for line in new)
    )
    return [
        f"⚠️ **New unmatched timetable names**: {names}. Add an alias under "
        "Internals (Course Names, Staff Names or Room Names) in Studio."
    ]


def check_stale(state: dict, *, key: str, table: str, column: str,
                limit: int, what: str, flow: str) -> list[str]:
    """An import whose last success (the newest `column` of `table`) is older
    than `limit` seconds, posted when it starts and when it ends."""
    age = sql(
        f"select coalesce(extract(epoch from now() - max({column}))::bigint::text, '') "
        f"from {table}"
    )
    last = sql(f"select coalesce(to_char(max({column}) at time zone 'UTC', "
               f"'YYYY-MM-DD HH24:MI'), 'never') from {table}")
    stale = age != "" and int(age) > limit
    messages = []
    if stale != state.get(key, False):
        messages.append(
            f"⚠️ **The {what} import has not succeeded since {last} UTC**. "
            f"Run Data / {flow} in Studio to see why."
            if stale else f"✅ The {what} import succeeded again"
        )
    state[key] = stale
    return messages


def check_moodle(state: dict) -> list[str]:
    """Uncounted Moodle courses (with a year and at least 5 students) whose
    name starts with a course's name, each posted once. The first check
    records the ones already there (old curricula, courses left out on
    purpose) silently."""
    rows = sql(MOODLE_UNCOUNTED)
    uncounted = rows.splitlines() if rows else []
    baseline = "moodle_uncounted" not in state
    known = set(state.get("moodle_uncounted", []))
    state["moodle_uncounted"] = uncounted
    new = [line for line in uncounted if line not in known]
    if baseline or not new:
        return []
    shown = ", ".join(
        f'"{label}" ({course})'
        for label, course in (line.split("\t", 1) for line in new[:10])
    )
    more = f" and {len(new) - 10} more" if len(new) > 10 else ""
    return [
        f"⚠️ **New Moodle courses that look like a course but are not "
        f"counted**: {shown}{more}. Fix that course's Moodle Patterns (Enrollments) in "
        "Studio, or leave it if it is a different course."
    ]


def watch() -> None:
    first_run = not STATE.exists()
    state = {} if first_run else json.loads(STATE.read_text())
    messages = [
        *check_operations(state),
        *check_health(state),
        *check_timetable_names(state),
        *check_stale(state, key="timetables_stale", table="timetables",
                     column="checked_at", limit=TIMETABLE_STALE_SECONDS,
                     what="timetable", flow="Import timetables"),
        # Every successful thesis import replaces them all, stamping imported_at.
        *check_stale(state, key="theses_stale", table="bachelor_theses",
                     column="imported_at", limit=THESES_STALE_SECONDS,
                     what="thesis", flow="Import theses"),
        *check_moodle(state),
    ]
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state))
    if first_run:
        return  # the first run records what is already there
    for message in messages:
        send(message)


if __name__ == "__main__":
    if sys.argv[1:2] == ["send"] and len(sys.argv) == 3:
        send(sys.argv[2])
    elif sys.argv[1:] == ["watch"]:
        watch()
    else:
        raise SystemExit(__doc__)
