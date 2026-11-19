<script setup lang="ts">
import { ref } from 'vue';

import type { Person, SearchController } from './index.js';

import { countText } from './count-text.js';
import { profileUrl, splitHistory } from './history.js';

const { people, sort } = defineProps<{
  people: Person[];
  sort: SearchController['sort'];
}>();
const emit = defineEmits<{ 'update:sort': [sort: SearchController['sort']] }>();
const expanded = ref(new Set<number | string>());
function toggle(id: number | string, event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLDetailsElement)) return;
  if (target.open) expanded.value.add(id);
  else expanded.value.delete(id);
}

function toggleSort() {
  emit(
    'update:sort',
    sort === '-Courses Count' ? 'Courses Count' : '-Courses Count',
  );
}
</script>

<template>
  <!-- Focusable so keyboard users can scroll a table wider than the panel. -->
  <section
    class="results-scroll"
    aria-label="Matching users"
    tabindex="0"
  >
    <table>
      <thead>
        <tr>
          <th scope="col">User</th>
          <th scope="col">Moodle profile</th>
          <th
            scope="col"
            :aria-sort="
              sort === 'Name'
                ? 'none'
                : sort === 'Courses Count'
                  ? 'ascending'
                  : 'descending'
            "
          >
            <button
              class="sort-heading"
              type="button"
              :aria-label="
                sort === '-Courses Count'
                  ? 'Sort course history: fewest courses first'
                  : 'Sort course history: most courses first'
              "
              @click="toggleSort"
            >
              Course history
              <v-icon
                :name="
                  sort === 'Name'
                    ? 'unfold_more'
                    : sort === 'Courses Count'
                      ? 'arrow_upward'
                      : 'arrow_downward'
                "
                small
              />
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="person in people"
          :key="person.id"
        >
          <td>
            <router-link
              class="person-name"
              :to="`/content/moodle_users/${person.id}`"
              >{{ person.Name }}</router-link
            >
            <span
              v-if="person.Mail?.trim()"
              class="email"
              >{{ person.Mail }}</span
            >
          </td>
          <td class="profiles">
            <a
              v-if="profileUrl(person.Profile_new)"
              :href="profileUrl(person.Profile_new)"
              target="_blank"
              rel="noopener noreferrer"
              >Profile
              <v-icon
                name="open_in_new"
                x-small
            /></a>
            <a
              v-if="profileUrl(person.Profile_old)"
              :href="profileUrl(person.Profile_old)"
              target="_blank"
              rel="noopener noreferrer"
              >Old profile
              <v-icon
                name="open_in_new"
                x-small
            /></a>
            <span
              v-if="
                !profileUrl(person.Profile_new) &&
                !profileUrl(person.Profile_old)
              "
              class="muted"
              >No profile link</span
            >
          </td>
          <td>
            <details @toggle="(event: Event) => toggle(person.id, event)">
              <summary>
                {{
                  countText(
                    person['Courses Count'] ??
                      splitHistory(person.Courses).length,
                    'course',
                    'courses',
                  )
                }}
                <span class="muted">· View history</span>
              </summary>
              <ul v-if="expanded.has(person.id)">
                <li
                  v-for="(course, index) in splitHistory(person.Courses)"
                  :key="`${index}-${course}`"
                  :class="{ matched: person.matched.includes(course) }"
                >
                  {{ course }}
                </li>
              </ul>
            </details>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.results-scroll {
  overflow-x: auto;
}
table {
  inline-size: 100%;
  min-inline-size: 640px;
  border-collapse: collapse;
  table-layout: fixed;
}
th,
td {
  text-align: start;
  border-block-end: 1px solid var(--theme--border-color-subdued);
}
th {
  block-size: 48px;
  padding: 12px 16px;
  color: var(--theme--foreground-subdued);
  font-weight: 500;
}
td {
  padding: 12px 16px;
  vertical-align: middle;
}
th:first-child {
  inline-size: 34%;
}
th:nth-child(2) {
  inline-size: 24%;
}
.sort-heading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.sort-heading:hover {
  color: var(--theme--foreground-accent);
}
.sort-heading:focus-visible {
  outline: 2px solid var(--theme--primary);
  outline-offset: 3px;
}
tbody tr:hover {
  background: var(--theme--background-subdued);
}
.person-name {
  font-weight: 500;
  overflow-wrap: anywhere;
}
a {
  color: var(--theme--primary);
  text-underline-offset: 3px;
}
a:hover {
  text-decoration: underline;
}
.email {
  display: block;
  margin-block-start: 4px;
  font-size: 13px;
  color: var(--theme--foreground-subdued);
  overflow-wrap: anywhere;
}
.profiles a {
  display: flex;
  align-items: center;
  gap: 6px;
  inline-size: fit-content;
  white-space: nowrap;
}
.profiles a + a {
  margin-block-start: 8px;
}
.muted {
  color: var(--theme--foreground-subdued);
}
summary {
  cursor: pointer;
}
details ul {
  margin-block-start: 12px;
  list-style: none;
}
details li {
  padding-block: 5px;
  overflow-wrap: anywhere;
}
.matched {
  color: var(--theme--primary);
  font-weight: 600;
}
a:focus-visible,
summary:focus-visible,
.results-scroll:focus-visible {
  outline: 2px solid var(--theme--primary);
  outline-offset: 3px;
}
</style>
