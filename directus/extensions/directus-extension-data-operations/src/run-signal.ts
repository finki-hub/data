import { ref } from 'vue';

// What the Run operation panels of one Studio page tell each other and the
// status panels: how many of their runs are in flight, and a counter moved
// whenever one starts or ends. Every panel reads the status again on a
// move and keeps polling it while a run is in flight, so every Run button
// follows the server's claim during any run started on the page. It lives
// in the app bundle, which Studio loads once per page.
export const runsInFlight = ref(0);
export const runSignal = ref(0);

export const startRun = (): void => {
  runsInFlight.value += 1;
  runSignal.value += 1;
};

export const endRun = (): void => {
  runsInFlight.value = Math.max(0, runsInFlight.value - 1);
  runSignal.value += 1;
};
