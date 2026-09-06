import { defineLayout, useApi } from '@directus/extensions-sdk';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { z } from 'zod';

import CourseSearch from './search.vue';

const personSchema = z.object({
  id: z.union([z.string(), z.number()]),
  Name: z.string(),
  Mail: z.string().nullish(),
  Profile_new: z.string().nullish(),
  Profile_old: z.string().nullish(),
  Courses: z.string().nullish(),
  'Courses Count': z.number().nullish(),
});
const resultsSchema = z.object({ data: z.array(personSchema), total: z.number().int().min(0) });
const optionsSchema = z.object({ data: z.array(z.string()) });

export type Person = z.infer<typeof personSchema>;

export type SearchController = {
  include: string[];
  exclude: string[];
  page: number;
  sort: 'Name' | 'Courses Count' | '-Courses Count';
  readonly courses: string[];
  readonly people: Person[];
  readonly total: number;
  readonly pages: number;
  readonly loading: boolean;
  readonly loadingCourses: boolean;
  readonly error: string | null;
  readonly coursesError: string | null;
  readonly supported: boolean;
  readonly hasCriteria: boolean;
  readonly hasNativeFilters: boolean;
  readonly reset: () => void;
  readonly loadCourses: () => Promise<void>;
  readonly search: () => Promise<void>;
  readonly refresh: () => Promise<void[]>;
};

const layout = defineLayout({
  id: 'finki-hub-course-search',
  name: 'Course history search',
  icon: 'person_search',
  component: CourseSearch,
  slots: { options: () => null, sidebar: () => null, actions: () => null },
  setup(props) {
    const api = useApi();
    const include = ref<string[]>([]);
    const exclude = ref<string[]>([]);
    const courses = ref<string[]>([]);
    const people = ref<Person[]>([]);
    const page = ref(1);
    const sort = ref<SearchController['sort']>('Name');
    const total = ref(0);
    const loading = ref(false);
    const loadingCourses = ref(false);
    const error = ref<string | null>(null);
    const coursesError = ref<string | null>(null);
    const supported = computed(() => props.collection === 'moodle_users');
    let resultsRequest: AbortController | undefined;
    let optionsRequest: AbortController | undefined;

    async function loadCourses() {
      if (!supported.value) return;
      optionsRequest?.abort();
      const request = new AbortController();
      optionsRequest = request;
      loadingCourses.value = true;
      coursesError.value = null;
      try {
        const response = await api.get<unknown>('/finki-hub-course-history/options', { signal: request.signal });
        if (!request.signal.aborted) courses.value = optionsSchema.parse(response.data).data;
      } catch (cause) {
        if (request.signal.aborted) return;
        coursesError.value = cause instanceof Error
          ? 'Could not load course choices. Check your access to Moodle Users and try again.'
          : 'Course choices are unavailable. Try again.';
      } finally {
        if (!request.signal.aborted) loadingCourses.value = false;
      }
    }

    async function search() {
      if (!supported.value) return;
      resultsRequest?.abort();
      const request = new AbortController();
      resultsRequest = request;
      loading.value = true;
      error.value = null;
      try {
        const response = await api.post<unknown>('/finki-hub-course-history/search', {
          include: include.value,
          exclude: exclude.value,
          page: page.value,
          sort: sort.value,
          search: props.search,
          filter: props.filter,
        }, { signal: request.signal });
        if (request.signal.aborted) return;
        const result = resultsSchema.parse(response.data);
        people.value = result.data;
        total.value = result.total;
      } catch (cause) {
        if (request.signal.aborted) return;
        people.value = [];
        total.value = 0;
        error.value = cause instanceof Error
          ? 'Could not load matching people. Check your access to Moodle Users and try again.'
          : 'Search is unavailable. Try again.';
      } finally {
        if (!request.signal.aborted) loading.value = false;
      }
    }

    function reset() {
      include.value = [];
      exclude.value = [];
      page.value = 1;
    }

    function refresh() {
      return Promise.all([loadCourses(), search()]);
    }

    watch([include, exclude, sort, () => props.filter, () => props.search], () => { page.value = 1; }, { deep: true });
    watch([include, exclude, page, sort, () => props.filter, () => props.search], search, { deep: true, immediate: true });
    onMounted(loadCourses);
    onBeforeUnmount(() => { resultsRequest?.abort(); optionsRequest?.abort(); });

    return {
      refresh,
      controller: reactive({
        include, exclude, courses, people, page, sort, total, loading, loadingCourses,
        error, coursesError, supported, loadCourses, search, reset, refresh,
        pages: computed(() => Math.max(1, Math.ceil(total.value / 50))),
        hasCriteria: computed(() => include.value.length + exclude.value.length > 0),
        hasNativeFilters: computed(() => Boolean(props.search || props.filter && Object.keys(props.filter).length)),
      }),
    };
  },
});

export default layout;
