<script setup lang="ts">
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';

import { courseLimit } from './limits.js';

const { blocked, courses, id, loading, selected, title } = defineProps<{
  blocked: string[];
  courses: string[];
  id: string;
  loading: boolean;
  selected: string[];
  title: string;
}>();
const emit = defineEmits<{ 'update:selected': [courses: string[]] }>();
const query = ref('');
const open = ref(false);
const activeIndex = ref(-1);
const full = computed(() => selected.length >= courseLimit);
const disabled = computed(() => loading || full.value);
const placeholder = computed(() => {
  if (loading) return 'Loading courses…';
  return full.value
    ? `Limit reached: ${String(courseLimit)} courses`
    : 'Search courses…';
});
const available = computed(() =>
  courses.filter(
    (course) => !selected.includes(course) && !blocked.includes(course),
  ),
);
const matches = computed(() => {
  const words = query.value
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return available.value.filter((course) => {
    const label = course.toLocaleLowerCase();
    return words.every((word) => label.includes(word));
  });
});
const scrollElement = useTemplateRef<HTMLDivElement>('scroller');
const itemKey = computed(() => {
  const listed = matches.value;
  return (index: number) => listed[index] ?? index;
});
const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>(
  computed(() => {
    const active = activeIndex.value;
    return {
      count: matches.value.length,
      enabled: open.value,
      estimateSize: () => 56,
      getItemKey: itemKey.value,
      getScrollElement: () => scrollElement.value,
      overscan: 5,
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indices = defaultRangeExtractor(range);
        if (
          active >= 0 &&
          active < matches.value.length &&
          !indices.includes(active)
        )
          indices.push(active);
        return indices.sort((left, right) => left - right);
      },
    };
  }),
);
const virtualRows = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());
watch(
  matches,
  () => {
    activeIndex.value = -1;
    virtualizer.value.scrollToOffset(0);
  },
  { flush: 'post' },
);
watch(open, (value) => {
  if (!value) activeIndex.value = -1;
});
watch(disabled, (value) => {
  if (value) open.value = false;
});

function add(value: unknown) {
  if (
    typeof value === 'string' &&
    available.value.includes(value) &&
    !full.value
  ) {
    emit('update:selected', [...selected, value]);
    query.value = '';
    open.value = false;
    activeIndex.value = -1;
  }
}

async function keydown(event: KeyboardEvent) {
  if (event.isComposing || disabled.value) return;
  if (event.key === 'Escape' || event.key === 'Tab') {
    open.value = false;
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const course = matches.value[activeIndex.value];
    if (open.value && course) add(course);
    else open.value = true;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  open.value = true;
  const count = matches.value.length;
  if (!count) return;
  let step = -1;
  if (event.key === 'ArrowDown') step = 1;
  else if (activeIndex.value < 0) step = 0;
  activeIndex.value = (activeIndex.value + step + count) % count;
  await nextTick();
  virtualizer.value.scrollToIndex(activeIndex.value, { align: 'auto' });
}

function measureRow(element: unknown) {
  if (element instanceof HTMLLIElement)
    virtualizer.value.measureElement(element);
}

function openUnlessDisabled() {
  open.value = !disabled.value;
}

function remove(course: string) {
  emit(
    'update:selected',
    selected.filter((value) => value !== course),
  );
}

function updateQuery(value: null | string) {
  query.value = value ?? '';
  open.value = true;
}
</script>

<template>
  <section
    class="course-picker"
    :aria-labelledby="`${id}-label`"
  >
    <h3 :id="`${id}-label`">{{ title }}</h3>
    <v-menu
      v-model="open"
      attached
      full-height
      placement="bottom-start"
      :disabled="disabled"
      :close-on-content-click="false"
      no-focus-return
    >
      <template #activator>
        <v-input
          class="course-field"
          :model-value="query"
          :disabled="disabled"
          :nullable="false"
          :active="open"
          :placeholder="placeholder"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="open"
          :aria-controls="`${id}-options`"
          :aria-activedescendant="
            open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
          "
          :aria-labelledby="`${id}-label`"
          @update:model-value="updateQuery"
          @focus="openUnlessDisabled"
          @click="openUnlessDisabled"
          @keydown="keydown"
        >
          <template
            v-if="selected.length"
            #prepend
          >
            <ul
              class="selected-courses"
              :aria-label="`${title}: selected courses`"
            >
              <li
                v-for="course in selected"
                :key="course"
              >
                <v-chip kind="primary">
                  <span class="selected-label">{{ course }}</span>
                  <button
                    type="button"
                    :aria-label="`Remove ${course}`"
                    @click.stop="() => remove(course)"
                  >
                    <v-icon
                      name="close"
                      small
                    />
                  </button>
                </v-chip>
              </li>
            </ul>
          </template>
          <template #append><v-icon name="search" /></template>
        </v-input>
      </template>
      <output
        v-if="!matches.length"
        class="empty-options"
        >No matching courses</output
      >
      <div
        ref="scroller"
        class="course-options-scroll"
      >
        <v-list
          :id="`${id}-options`"
          role="listbox"
          :aria-labelledby="`${id}-label`"
          class="course-options"
          :style="{ height: `${totalSize}px` }"
        >
          <li
            v-for="row in virtualRows"
            :key="String(row.key)"
            :ref="measureRow"
            :data-index="row.index"
            class="course-option"
            role="presentation"
            :style="{ transform: `translateY(${row.start}px)` }"
          >
            <v-list-item
              :id="`${id}-option-${row.index}`"
              role="option"
              :aria-selected="row.index === activeIndex"
              :active="row.index === activeIndex"
              :aria-posinset="row.index + 1"
              :aria-setsize="matches.length"
              clickable
              tabindex="-1"
              @mousedown.prevent
              @click="() => add(matches[row.index])"
            >
              <v-list-item-content class="course-label">{{
                matches[row.index]
              }}</v-list-item-content>
            </v-list-item>
          </li>
        </v-list>
      </div>
    </v-menu>
  </section>
</template>

<style scoped>
.course-picker {
  min-inline-size: 0;
}
h3 {
  margin-block-end: 8px;
  font-weight: 600;
  font-size: 16px;
  color: var(--theme--foreground-accent);
}
.course-field {
  block-size: auto;
}
.course-field :deep(.input) {
  position: relative;
  flex-wrap: wrap;
  gap: 8px;
  block-size: auto;
  min-block-size: var(--theme--form--field--input--height);
  padding-block: 8px;
}
.course-field :deep(.prepend) {
  display: contents;
}
.course-field :deep(input) {
  flex: 1 1 12rem;
  min-inline-size: 0;
  block-size: 32px;
  padding-block: 0;
  padding-inline-end: 32px;
}
.course-field :deep(.append) {
  position: absolute;
  inset-inline-end: var(--theme--form--field--input--padding);
  inset-block-end: 12px;
  margin: 0;
}
.selected-courses {
  display: contents;
  list-style: none;
}
.selected-courses li {
  display: flex;
  min-inline-size: 0;
  max-inline-size: 100%;
}
.selected-courses .v-chip {
  block-size: auto;
  min-block-size: 32px;
  max-inline-size: 100%;
}
.selected-courses :deep(.chip-content) {
  min-inline-size: 0;
  white-space: normal;
}
.selected-label {
  overflow-wrap: anywhere;
}
.course-options-scroll {
  max-block-size: min(240px, calc(30vh - 16px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.course-options {
  --v-list-min-width: 0;
  --v-list-padding: 0;
  position: relative;
  overflow: visible;
}
.course-option {
  position: absolute;
  inset-block-start: 0;
  inset-inline: 0;
  padding-block: 2px;
}
.course-option :deep(.v-list-item) {
  margin: 0;
}
.course-label {
  white-space: normal;
  overflow-wrap: anywhere;
}
.empty-options {
  display: block;
  padding: 8px 12px;
  margin: 0;
  color: var(--theme--foreground-subdued);
}
.selected-courses button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  inline-size: 28px;
  block-size: 28px;
  border-radius: var(--theme--border-radius);
  color: var(--theme--foreground-subdued);
  cursor: pointer;
}
.selected-courses button:hover {
  background: var(--theme--background-accent);
  color: var(--theme--foreground-accent);
}
.selected-courses button:focus-visible {
  outline: 2px solid var(--theme--primary);
  outline-offset: 2px;
}
</style>
