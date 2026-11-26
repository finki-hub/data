<script setup lang="ts">
import type { SearchController } from './index.js';

import { countText, rangeText } from './count-text.js';
import CoursePicker from './course-picker.vue';
import CsvDownload from './csv-download.vue';
import { nameLength } from './limits.js';
import SearchResults from './search-results.vue';

defineOptions({ inheritAttrs: false });
const { controller } = defineProps<{ controller: SearchController }>();

function changeMatch(event: Event) {
  const { value } = event.target as HTMLInputElement;
  if (value === 'course' || value === 'line') controller.setMatch(value);
}
</script>

<template>
  <div class="course-search">
    <template v-if="controller.supported">
      <header class="search-heading">
        <h2>Course history search</h2>
        <v-button
          secondary
          small
          :disabled="controller.loadingCourses"
          @click="controller.refresh"
          ><v-icon
            name="refresh"
            left
            small
          />Refresh data</v-button
        >
      </header>

      <section
        class="name-search"
        aria-labelledby="name-label"
      >
        <h3 id="name-label">Name</h3>
        <v-input
          :model-value="controller.name"
          :nullable="false"
          :maxlength="nameLength"
          placeholder="First name, last name or both, in Cyrillic or Latin, or a mail address"
          aria-labelledby="name-label"
          @update:model-value="controller.setName"
          ><template #append><v-icon name="search" /></template
        ></v-input>
      </section>

      <fieldset class="match-mode">
        <legend>Match by</legend>
        <label
          ><input
            type="radio"
            name="match"
            value="course"
            :checked="controller.match === 'course'"
            @change="changeMatch"
          />Course</label
        >
        <label
          ><input
            type="radio"
            name="match"
            value="line"
            :checked="controller.match === 'line'"
            @change="changeMatch"
          />Moodle course name</label
        >
        <p>
          {{
            controller.match === 'course'
              ? 'A course matches every Moodle course counted for it: its name variants, English names and links, in every year.'
              : 'A Moodle course name matches only that exact name.'
          }}
        </p>
      </fieldset>

      <div class="criteria">
        <CoursePicker
          id="include"
          title="Has all these courses"
          :selected="controller.include"
          :blocked="controller.exclude"
          :courses="controller.courses"
          :loading="controller.loadingCourses"
          @update:selected="controller.setInclude"
        />
        <CoursePicker
          id="exclude"
          title="Has none of these courses"
          :selected="controller.exclude"
          :blocked="controller.include"
          :courses="controller.courses"
          :loading="controller.loadingCourses"
          @update:selected="controller.setExclude"
        />
      </div>
      <v-notice
        v-if="controller.coursesError"
        type="warning"
        >{{ controller.coursesError }}
        <button
          class="retry"
          type="button"
          @click="controller.loadCourses"
        >
          Retry
        </button></v-notice
      >

      <section
        class="results-section"
        :aria-busy="controller.loading"
      >
        <div class="results-heading">
          <div aria-live="polite">
            <h3>
              {{
                controller.loading
                  ? 'Loading users…'
                  : countText(
                      controller.total,
                      'matching user',
                      'matching users',
                    )
              }}
            </h3>
          </div>
          <div class="results-actions">
            <v-button
              v-if="controller.hasCriteria"
              secondary
              small
              @click="controller.reset"
              >Clear criteria</v-button
            >
            <CsvDownload
              v-if="controller.total && !controller.error"
              :criteria="controller.criteria"
            />
          </div>
        </div>
        <p
          v-if="controller.nativeCriteria.length"
          class="matching-note"
        >
          Filtered by page header: {{ controller.nativeCriteria.join(', ') }}
        </p>
        <v-notice
          v-if="controller.error"
          key="v-notice-3"
          type="danger"
          >{{ controller.error }}
          <button
            class="retry"
            type="button"
            @click="controller.search"
          >
            Retry
          </button></v-notice
        >
        <div
          v-else-if="controller.loading && !controller.people.length"
          class="empty-state"
        >
          <v-progress-circular indeterminate />
        </div>
        <SearchResults
          v-else-if="controller.people.length"
          :sort="controller.sort"
          :people="controller.people"
          :inert="controller.loading"
          :class="{ refreshing: controller.loading }"
          @update:sort="controller.setSort"
        />
        <div
          v-else
          class="empty-state"
        >
          <v-icon
            name="person_search"
            large
          />
          <h3>No matching users</h3>
        </div>
        <footer
          v-if="controller.total && !controller.error"
          class="pagination"
        >
          <span>{{ rangeText(controller.page, controller.total) }}</span>
          <v-pagination
            v-if="controller.pages > 1"
            :model-value="controller.page"
            :length="controller.pages"
            :total-visible="5"
            :disabled="controller.loading"
            @update:model-value="controller.setPage"
          />
        </footer>
      </section>
    </template>
    <v-notice
      v-else
      type="info"
      >Layout supports Moodle users only</v-notice
    >
  </div>
</template>

<style scoped>
.course-search {
  padding: 24px 32px 48px;
  color: var(--theme--foreground);
  font-family: var(--theme--fonts--sans--font-family);
}
:global(.scrolling-container:has(.course-search)) {
  scrollbar-gutter: stable;
}
.search-heading,
.results-heading,
.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
}
.search-heading {
  margin-block-end: 28px;
}
h2 {
  font-family: var(--theme--fonts--display--font-family);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--theme--foreground-accent);
}
h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--theme--foreground-accent);
}
p {
  color: var(--theme--foreground-subdued);
  line-height: 1.5;
  margin-block-start: 6px;
}
.name-search {
  max-width: 640px;
  margin-block-end: 28px;
}
.name-search h3 {
  margin-block-end: 8px;
}
.match-mode {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
  margin-block-end: 20px;
  border: none;
  padding: 0;
}
.match-mode legend {
  float: left;
  font-weight: 600;
  color: var(--theme--foreground-accent);
}
.match-mode label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.match-mode input {
  accent-color: var(--theme--primary);
}
.match-mode p {
  flex-basis: 100%;
  margin: 0;
  font-size: 13px;
}
.criteria {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
  gap: 24px;
}
.matching-note {
  font-size: 13px;
  margin-block: 16px;
}
.results-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.results-section {
  margin-block-start: 32px;
  border-block-start: 1px solid var(--theme--border-color);
}
.results-heading {
  padding-block: 24px 18px;
}
.refreshing {
  opacity: 0.5;
}
.empty-state {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 56px 24px;
  text-align: center;
  color: var(--theme--foreground-subdued);
}
.pagination {
  padding-block-start: 20px;
  color: var(--theme--foreground-subdued);
  font-variant-numeric: tabular-nums;
}
.retry {
  margin-inline-start: 12px;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.retry:focus-visible {
  outline: 2px solid var(--theme--primary);
  outline-offset: 3px;
}
@media (max-width: 600px) {
  .course-search {
    padding: 20px 16px 32px;
  }
}
</style>
