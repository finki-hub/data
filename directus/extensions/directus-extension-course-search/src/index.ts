import { defineLayout, useApi } from '@directus/extensions-sdk';
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { z } from 'zod';

import type { MatchMode } from './criteria.js';

import { failureText } from './failure-text.js';
import { pageSize } from './limits.js';
import CourseSearch from './search-layout.vue';

const personSchema = z.object({
  id: z.union([z.string(), z.number()]),
  Name: z.string(),
  Mail: z.string().nullish(),
  Profile_new: z.string().nullish(),
  Profile_old: z.string().nullish(),
  Courses: z.string().nullish(),
  'Courses Count': z.number().nullish(),
  matched: z.array(z.string()).default([]),
});
const resultsSchema = z.object({
  data: z.array(personSchema),
  total: z.number().int().min(0),
});
const optionsSchema = z.object({ data: z.array(z.string()) });

// How long typing in the name field rests before it searches.
const nameDelay = 300;

export type Person = z.infer<typeof personSchema>;

// The layout's state as its component reads it. The component changes
// the criteria, page and sort only through the setters, never by writing
// to the prop.
export type SearchController = {
  readonly match: MatchMode;
  readonly name: string;
  readonly include: string[];
  readonly exclude: string[];
  readonly page: number;
  readonly sort: 'Name' | 'Courses Count' | '-Courses Count';
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
  readonly nativeCriteria: readonly string[];
  readonly reset: () => void;
  readonly loadCourses: () => Promise<void>;
  readonly search: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly setMatch: (match: MatchMode) => void;
  readonly setName: (name: string) => void;
  readonly setInclude: (courses: string[]) => void;
  readonly setExclude: (courses: string[]) => void;
  readonly setPage: (page: number) => void;
  readonly setSort: (sort: SearchController['sort']) => void;
};

const layout = defineLayout({
  id: 'finki-hub-course-search',
  name: 'Course history search',
  icon: 'person_search',
  component: CourseSearch,
  slots: { options: () => null, sidebar: () => null, actions: () => null },
  setup(props) {
    const api = useApi();
    // By course unless the user picks Moodle course names.
    const match = ref<MatchMode>('course');
    const include = ref<string[]>([]);
    // The name field as typed, and the name the search last used.
    const name = ref('');
    const nameQuery = ref('');
    let nameTimer: ReturnType<typeof setTimeout> | undefined;
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

    const loadCourses = async (): Promise<void> => {
      if (!supported.value) return;
      optionsRequest?.abort();
      const request = new AbortController();
      optionsRequest = request;
      loadingCourses.value = true;
      coursesError.value = null;
      try {
        const response = await api.get<unknown>(
          '/finki-hub-course-history/options',
          { params: { match: match.value }, signal: request.signal },
        );
        if (!request.signal.aborted)
          courses.value = optionsSchema.parse(response.data).data;
      } catch (error_) {
        if (request.signal.aborted) return;
        coursesError.value = failureText('Course list', error_);
      } finally {
        if (!request.signal.aborted) loadingCourses.value = false;
      }
    };

    const search = async (): Promise<void> => {
      if (!supported.value) return;
      resultsRequest?.abort();
      const request = new AbortController();
      resultsRequest = request;
      loading.value = true;
      error.value = null;
      try {
        const response = await api.post<unknown>(
          '/finki-hub-course-history/search',
          {
            match: match.value,
            name: nameQuery.value,
            include: include.value,
            exclude: exclude.value,
            page: page.value,
            sort: sort.value,
            search: props.search,
            filter: props.filter,
          },
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        const result = resultsSchema.parse(response.data);
        people.value = result.data;
        total.value = result.total;
      } catch (error_) {
        if (request.signal.aborted) return;
        people.value = [];
        total.value = 0;
        error.value = failureText('Search', error_);
      } finally {
        if (!request.signal.aborted) loading.value = false;
      }
    };

    const reset = (): void => {
      clearTimeout(nameTimer);
      name.value = '';
      nameQuery.value = '';
      include.value = [];
      exclude.value = [];
      page.value = 1;
    };

    const refresh = async (): Promise<void> => {
      await Promise.all([loadCourses(), search()]);
    };

    watch(
      [
        match,
        nameQuery,
        include,
        exclude,
        sort,
        () => props.filter,
        () => props.search,
      ],
      () => {
        page.value = 1;
      },
      { deep: true },
    );
    watch(
      [
        match,
        nameQuery,
        include,
        exclude,
        page,
        sort,
        () => props.filter,
        () => props.search,
      ],
      search,
      { deep: true, immediate: true },
    );
    onMounted(loadCourses);
    onBeforeUnmount(() => {
      clearTimeout(nameTimer);
      resultsRequest?.abort();
      optionsRequest?.abort();
    });

    return {
      refresh,
      controller: reactive({
        match,
        name,
        include,
        exclude,
        courses,
        people,
        page,
        sort,
        total,
        loading,
        loadingCourses,
        error,
        coursesError,
        supported,
        loadCourses,
        search,
        reset,
        refresh,
        // A picked name means something else in the other mode, so a
        // switch clears both lists and loads the other mode's names.
        setMatch: (value: MatchMode) => {
          if (value === match.value) return;
          include.value = [];
          exclude.value = [];
          courses.value = [];
          match.value = value;
          void loadCourses();
        },
        setName: (value: string) => {
          name.value = value;
          clearTimeout(nameTimer);
          nameTimer = setTimeout(() => {
            nameQuery.value = value.trim();
          }, nameDelay);
        },
        setInclude: (value: string[]) => {
          include.value = value;
        },
        setExclude: (value: string[]) => {
          exclude.value = value;
        },
        setPage: (value: number) => {
          page.value = value;
        },
        setSort: (value: SearchController['sort']) => {
          sort.value = value;
        },
        pages: computed(() => Math.max(1, Math.ceil(total.value / pageSize))),
        hasCriteria: computed(
          () =>
            name.value.trim().length +
              include.value.length +
              exclude.value.length >
            0,
        ),
        // The page header's own criteria that narrow the search too.
        nativeCriteria: computed(() => [
          ...(props.search ? ['search'] : []),
          ...(Object.keys(props.filter ?? {}).length > 0 ? ['filter'] : []),
        ]),
      }),
    };
  },
});

export default layout;
