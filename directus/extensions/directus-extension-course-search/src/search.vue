<script setup lang="ts">
import type { SearchController } from './index.js';
import { countText, rangeText } from './count-text.js';
import CoursePicker from './course-picker.vue';
import Results from './results.vue';

defineOptions({ inheritAttrs: false });
defineProps<{ controller: SearchController }>();
</script>

<template>
  <div class="course-search">
    <v-notice v-if="!controller.supported" type="info">Layout supports Moodle Users only</v-notice>
    <template v-else>
      <header class="search-heading">
        <h2>Course history search</h2>
        <v-button secondary small :disabled="controller.loadingCourses" @click="controller.refresh"><v-icon name="refresh" left small />Refresh data</v-button>
      </header>

      <div class="criteria">
        <CoursePicker id="include" title="Has all these courses"
          :selected="controller.include" :blocked="controller.exclude" :courses="controller.courses" :loading="controller.loadingCourses"
          @change="controller.include = $event" />
        <CoursePicker id="exclude" title="Has none of these courses"
          :selected="controller.exclude" :blocked="controller.include" :courses="controller.courses" :loading="controller.loadingCourses"
          @change="controller.exclude = $event" />
      </div>
      <v-notice v-if="controller.coursesError" type="warning">{{ controller.coursesError }} <button class="retry" type="button" @click="controller.loadCourses">Retry</button></v-notice>

      <section class="results-section" :aria-busy="controller.loading">
        <div class="results-heading">
          <div aria-live="polite">
            <h3>{{ controller.loading ? 'Loading users…' : countText(controller.total, 'matching user', 'matching users') }}</h3>
          </div>
          <v-button v-if="controller.hasCriteria" secondary small @click="controller.reset">Clear course selections</v-button>
        </div>
        <p v-if="controller.nativeCriteria.length" class="matching-note">Filtered by page header: {{ controller.nativeCriteria.join(', ') }}</p>
        <v-notice v-if="controller.error" type="danger">{{ controller.error }} <button class="retry" type="button" @click="controller.search">Retry</button></v-notice>
        <div v-else-if="controller.loading && !controller.people.length" class="empty-state"><v-progress-circular indeterminate /></div>
        <div v-else-if="!controller.people.length" class="empty-state"><v-icon name="person_search" large /><h3>No matching users</h3></div>
        <Results v-else v-model:sort="controller.sort" :people="controller.people" :included="controller.include" :inert="controller.loading" :class="{ refreshing: controller.loading }" />
        <footer v-if="controller.total && !controller.error" class="pagination">
          <span>{{ rangeText(controller.page, controller.total) }}</span>
          <v-pagination v-if="controller.pages > 1" v-model="controller.page" :length="controller.pages" :total-visible="5" :disabled="controller.loading" />
        </footer>
      </section>
    </template>
  </div>
</template>

<style scoped>
.course-search { padding: 24px 32px 48px; color: var(--theme--foreground); font-family: var(--theme--fonts--sans--font-family); }
:global(.scrolling-container:has(.course-search)) { scrollbar-gutter: stable; }
.search-heading, .results-heading, .pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.search-heading { margin-block-end: 28px; }
h2 { font-family: var(--theme--fonts--display--font-family); font-size: 20px; font-weight: 600; line-height: 1.4; color: var(--theme--foreground-accent); }
h3 { font-size: 16px; font-weight: 600; color: var(--theme--foreground-accent); }
p { color: var(--theme--foreground-subdued); line-height: 1.5; margin-block-start: 6px; }
.criteria { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 24px; }
.matching-note { font-size: 13px; margin-block: 16px; }
.results-section { margin-block-start: 32px; border-block-start: 1px solid var(--theme--border-color); }
.results-heading { padding-block: 24px 18px; }
.refreshing { opacity: 0.5; }
.empty-state { display: grid; justify-items: center; gap: 12px; padding: 56px 24px; text-align: center; color: var(--theme--foreground-subdued); }
.pagination { padding-block-start: 20px; color: var(--theme--foreground-subdued); font-variant-numeric: tabular-nums; }
.retry { margin-inline-start: 12px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.retry:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 3px; }
@media (max-width: 600px) { .course-search { padding: 20px 16px 32px; } }
</style>
