import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { processPendingFlowId } from '../../src/flows/process-pending.js';
import { get, patch } from './history-index-helpers.mjs';

// Measuring the full-size stress scenario (stress.opt-in.mjs): wall time
// per phase and the memory of the Directus and database containers, read
// from their cgroup v2 files on the host (read-only) in the foreground of
// the test process, only while a phase runs, every 250 ms and at most
// `maxSamples` times, stopped before the phase answers (and when the
// process ends). Nothing keeps sampling after the run. Two figures per
// container: the highest sampled usage (memory.current less
// inactive_file, the figure `docker stats` shows) with its sample count,
// and memory.peak, the kernel's true peak since the container started
// (page cache included), which is the phase's own peak when it rose during
// the phase.

const runCommand = promisify(execFile);
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const idPattern = /^[0-9a-f]{64}$/u;
const inactivePattern = /^inactive_file (?<bytes>\d+)$/mu;
const maxSamples = 12_000;
const sampleEveryMs = 250;
const mebibyte = 1_048_576;

// The cgroup v2 directory of a container under Docker's systemd driver.
export const cgroupOf = async (container) => {
  assert.match(container, containerPattern);
  const { stdout } = await runCommand('docker', [
    'inspect',
    '--format',
    '{{.Id}}',
    container,
  ]);
  const id = stdout.trim();
  assert.match(id, idPattern);
  const directory = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
  try {
    await readFile(path.join(directory, 'memory.peak'), 'utf8');
  } catch {
    assert.fail(
      `${container}: no readable cgroup v2 memory files under ${directory}; the stress scenario needs Docker's systemd cgroup driver on cgroup v2`,
    );
  }
  return directory;
};

const bytesIn = async (directory, name) =>
  Number(await readFile(path.join(directory, name), 'utf8'));

// The usage `docker stats` shows on cgroup v2, in MiB.
const usageOf = async (directory) => {
  const [current, stat] = await Promise.all([
    bytesIn(directory, 'memory.current'),
    readFile(path.join(directory, 'memory.stat'), 'utf8'),
  ]);
  const inactive = Number(inactivePattern.exec(stat)?.groups?.bytes ?? NaN);
  assert.ok(Number.isSafeInteger(inactive), 'memory.stat has inactive_file');
  return (current - inactive) / mebibyte;
};

const peakOf = async (directory) =>
  (await bytesIn(directory, 'memory.peak')) / mebibyte;

// Starts sampling the cgroups ({ name: directory }); `stop()` ends the
// loop, waits for it and answers per name the highest sampled usage, the
// memory.peak before and after, and the number of samples.
const startSampler = async (cgroups) => {
  const names = Object.keys(cgroups);
  const peaksBefore = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await peakOf(cgroups[name])]),
    ),
  );
  const highest = new Map();
  const control = { running: true, samples: 0 };
  const loop = (async () => {
    while (control.running && control.samples < maxSamples) {
      for (const name of names) {
        const usage = await usageOf(cgroups[name]);
        highest.set(name, Math.max(highest.get(name) ?? 0, usage));
      }
      control.samples += 1;
      if (control.running) await sleep(sampleEveryMs);
    }
  })();
  return {
    stop: async () => {
      control.running = false;
      await loop;
      const figures = {};
      for (const name of names) {
        const peak = await peakOf(cgroups[name]);
        figures[name] = {
          peakMiB: Math.round(peak),
          peakRose: peak > (peaksBefore[name] ?? 0),
          sampledMiB: Math.round(highest.get(name) ?? 0),
        };
      }
      return { figures, samples: control.samples };
    },
  };
};

// Runs one phase under the sampler and records its wall time and memory.
export const measured = async (context, name, body) => {
  const { cgroups, phases, t } = context;
  const sampler = await startSampler(cgroups);
  const started = performance.now();
  let result;
  try {
    result = await body();
  } finally {
    const ms = Math.round(performance.now() - started);
    const { figures, samples } = await sampler.stop();
    const phase = { ...figures, ms, name, samples };
    phases.push(phase);
    t.diagnostic(`phase ${JSON.stringify(phase)}`);
  }
  return result;
};

// The native schedule on or off (a status change the managed-graph
// fingerprint does not cover).
export const setSchedule = async (target, active) => {
  const status = active ? 'active' : 'inactive';
  await patch(target, `/flows/${processPendingFlowId}`, { status });
  const [flow] = await get(
    target,
    `/flows?fields=status&filter[id][_eq]=${processPendingFlowId}`,
  );
  assert.equal(flow.status, status);
};

// The duration of the last completed run the coordinator recorded.
export const lastRunMs = (report) =>
  Date.parse(report.lastRun.finishedAt) - Date.parse(report.lastRun.startedAt);

// The import state of the singleton, polled while a synchronous import
// runs: answers the first moment each state was seen.
export const watchImportState = (target) => {
  const seen = new Map();
  const started = performance.now();
  const control = { running: true };
  const loop = (async () => {
    while (control.running) {
      const singleton = await get(
        target,
        '/items/data_operations?fields=import_state',
      );
      const state = singleton?.import_state ?? 'none';
      if (!seen.has(state)) {
        seen.set(state, Math.round(performance.now() - started));
      }
      await sleep(200);
    }
  })();
  return {
    stop: async () => {
      control.running = false;
      await loop;
      return Object.fromEntries(seen);
    },
  };
};
