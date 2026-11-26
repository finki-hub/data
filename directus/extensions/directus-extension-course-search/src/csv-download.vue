<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { ref } from 'vue';

import { failureText } from './failure-text.js';

// Every user matching the criteria, saved as a CSV file.
const { criteria } = defineProps<{ criteria: Record<string, unknown> }>();
const api = useApi();
const busy = ref(false);
const error = ref<null | string>(null);

async function download() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const response = await api.post<Blob>(
      '/finki-hub-course-history/export',
      criteria,
      { responseType: 'blob' },
    );
    save(response.data);
  } catch (error_) {
    error.value = failureText('Download', error_);
  } finally {
    busy.value = false;
  }
}

function save(file: Blob) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'moodle-users.csv';
  link.click();
  // The browser reads the file after the click returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
</script>

<template>
  <v-button
    secondary
    small
    :loading="busy"
    @click="download"
    ><v-icon
      name="download"
      left
      small
    />Download CSV</v-button
  >
  <v-notice
    v-if="error"
    class="download-error"
    type="danger"
    >{{ error }}</v-notice
  >
</template>

<style scoped>
.download-error {
  flex-basis: 100%;
}
</style>
