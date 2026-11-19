<script setup lang="ts">
import { computed } from 'vue';

import type { StatusView } from './status-contract.js';

import { collectionPage } from './managed-flows.js';
import { attentionTotal, importStoppedText, moreText } from './status-facts.js';

// What is not linked up yet: Moodle courses named like a course that
// nothing counts, timetable names that match nothing, daily imports that
// stopped, and failed calculations. Each list links to its rows and to
// where the fix goes.
const { status } = defineProps<{ status: StatusView }>();

const attention = computed(() => status.attention);
const failed = computed(() =>
  status.domains.filter(({ state }) => state === 'failed'),
);
const total = computed(() => attentionTotal(status));

// Where the fix of an unmatched name goes.
const fixes = {
  room: { label: 'Room Names', link: collectionPage('room_aliases') },
  subject: { label: 'Course Names', link: collectionPage('course_aliases') },
  teacher: { label: 'Staff Names', link: collectionPage('staff_aliases') },
} as const;
const leftUncounted = collectionPage('moodle_left_uncounted');
const kindLabels = { room: 'Room', subject: 'Subject', teacher: 'Teacher' };
</script>

<template>
  <section
    class="block"
    aria-label="Needs attention"
  >
    <p
      v-if="total === 0"
      class="clear"
    >
      <v-icon
        name="check_circle"
        small
      />
      Nothing needs attention.
    </p>

    <div
      v-if="failed.length > 0"
      class="group"
      data-check="failed"
    >
      <h4>Failed calculations</h4>
      <p class="note">
        {{ failed.map(({ label }) => label).join(', ') }}. The Calculations
        panel shows the failure; Recalculate retries it.
      </p>
    </div>

    <div
      v-if="attention.stale.length > 0"
      class="group"
      data-check="stale"
    >
      <h4>Imports that stopped</h4>
      <ul>
        <li
          v-for="item in attention.stale"
          :key="item.name"
        >
          {{ importStoppedText(item) }}
        </li>
      </ul>
    </div>

    <div
      v-if="attention.unmatched.count > 0"
      class="group"
      data-check="unmatched"
    >
      <h4>Unmatched timetable names ({{ attention.unmatched.count }})</h4>
      <p class="note">
        They are left out of Timetable Teaching and courses.json. Add the name
        under
        <router-link :to="fixes.subject.link">{{
          fixes.subject.label
        }}</router-link>,
        <router-link :to="fixes.teacher.link">{{
          fixes.teacher.label
        }}</router-link>
        or
        <router-link :to="fixes.room.link">{{ fixes.room.label }}</router-link>,
        or mark it ignored there.
      </p>
      <ul>
        <li
          v-for="item in attention.unmatched.items"
          :key="`${item.kind}-${item.name}`"
        >
          <span class="kind">{{ kindLabels[item.kind] }}</span>
          <router-link :to="item.link">{{ item.name }}</router-link>
        </li>
      </ul>
      <p
        v-if="moreText(attention.unmatched)"
        class="note"
      >
        {{ moreText(attention.unmatched) }}
      </p>
    </div>

    <div
      v-if="attention.lookalikes.count > 0"
      class="group"
      data-check="lookalikes"
    >
      <h4>
        Moodle courses named like a course but not counted ({{
          attention.lookalikes.count
        }})
      </h4>
      <p class="note">
        Their students are missing from Enrollment Counts and Search by course.
        If it is that course, fix its Moodle Patterns or add a Moodle Course
        Link; if it is another one, add it to
        <router-link :to="leftUncounted">Left Uncounted</router-link>.
      </p>
      <ul>
        <li
          v-for="item in attention.lookalikes.items"
          :key="item.link"
        >
          <router-link :to="item.link">{{ item.label }}</router-link>
          <span class="note"> · looks like {{ item.course }}</span>
        </li>
      </ul>
      <p
        v-if="moreText(attention.lookalikes)"
        class="note"
      >
        {{ moreText(attention.lookalikes) }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.block {
  display: grid;
  gap: 16px;
}
.group {
  display: grid;
  gap: 6px;
}
h4 {
  font-weight: 600;
  color: var(--theme--foreground-accent);
}
ul {
  display: grid;
  gap: 2px;
  margin: 0;
  padding-inline-start: 18px;
}
li {
  line-height: 1.45;
  overflow-wrap: anywhere;
}
a {
  color: var(--theme--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
a:focus-visible {
  outline: 2px solid var(--theme--primary);
  outline-offset: 2px;
}
.kind {
  display: inline-block;
  min-inline-size: 64px;
  color: var(--theme--foreground-subdued);
}
.note {
  color: var(--theme--foreground-subdued);
  line-height: 1.45;
}
.clear {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--theme--success, var(--theme--primary));
}
</style>
