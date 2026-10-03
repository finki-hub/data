import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { get, post, remove } from './relational/history-index-helpers.mjs';

// The browser side of test/operations.browser.mjs: the locally installed
// agent-browser CLI, driven one command at a time (a vault login reads the
// password from stdin, never from the command line), and the synthetic
// users it logs in as. Nothing here keeps or prints a password or token.

const binaryName = 'agent-browser';
const refPattern = /\bref=(?<ref>e\d+)\]/u;
const restrictedPrefix = 'relational-restricted-';

// The agent-browser executable on the PATH, as an absolute path, or null.
const locate = async () => {
  const directories = (process.env.PATH ?? '').split(path.delimiter);
  for (const directory of directories) {
    if (directory === '' || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, binaryName);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
};

// The browser's environment: Chrome keeps a Unix socket in the temporary
// directory, whose path must stay short, so a long TMPDIR is not passed on.
const browserEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'TMPDIR'),
  );

// Runs the executable; answers its exit code and output. `input` is
// written to its stdin (the vault password). A command that exits before
// it reads its stdin breaks the pipe (EPIPE); its exit code and output
// tell what happened, so the broken pipe is only noted in stderr.
const runWith = (binary, args, input) =>
  new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: browserEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ code: 127, stderr: String(error.message), stdout });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
    child.stdin.on('error', (error) => {
      stderr += `stdin: ${error.message}\n`;
    });
    if (input === '') {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });

const unavailable = (cause) =>
  new Error(
    `agent-browser is not available (${cause}). Install it (npm i -g agent-browser && agent-browser install) and run npm run test:operations again; this suite refuses to skip its browser checks.`,
  );

const sessionList = z.object({
  data: z.object({ sessions: z.array(z.string()) }),
});

// The names of the CLI's active sessions (each has its own daemon).
// Listing starts no daemon.
const activeSessions = async (run) => {
  const answer = await run(['session', 'list', '--json']);
  assert.equal(answer.code, 0, 'agent-browser could not list its sessions');
  return sessionList.parse(JSON.parse(answer.stdout)).data.sessions;
};

// The CLI, or a refusal that says what to do when it is missing: the
// suite never skips its browser checks. `run(args, input)` answers
// { code, stdout, stderr }; `sessionsBefore` names the sessions that were
// already active, which the run leaves alone.
export const requireBrowser = async () => {
  const binary = await locate();
  if (binary === null) {
    throw unavailable('not found on the PATH');
  }
  const run = (args, input = '') => runWith(binary, args, input);
  const answer = await run(['--version']);
  if (answer.code !== 0) {
    throw unavailable(answer.stderr.trim() || `exit ${String(answer.code)}`);
  }
  return {
    run,
    sessionsBefore: await activeSessions(run),
    version: answer.stdout.trim(),
  };
};

// One browser session: every command runs in it; `command` fails the test
// on a non-zero exit, `attempt` answers the outcome.
export const browserSession = (cli, name) => {
  const attempt = (...args) => cli.run(['--session', name, ...args]);
  const command = async (...args) => {
    const answer = await attempt(...args);
    assert.equal(
      answer.code,
      0,
      `agent-browser ${args[0]} failed: ${answer.stderr.trim() || answer.stdout.trim()}`,
    );
    return answer.stdout;
  };
  // Clicks, retrying while a closing drawer or dialog still covers the
  // element (Studio animates them out).
  const click = async (selector) => {
    const started = Date.now();
    for (;;) {
      const answer = await attempt('click', selector);
      if (answer.code === 0) return;
      const said = `${answer.stdout}${answer.stderr}`;
      if (!said.includes('is covered by') || Date.now() - started > 10_000) {
        assert.fail(`agent-browser click ${selector} failed: ${said.trim()}`);
      }
      await sleep(300);
    }
  };
  return { attempt, click, command, name };
};

// The ref of the first interactive element whose snapshot line matches.
export const refIn = (snapshot, matches) => {
  const line = snapshot.split('\n').find(matches);
  const ref =
    line === undefined ? undefined : refPattern.exec(line)?.groups?.ref;
  assert.ok(
    ref !== undefined,
    `no element matches in:\n${snapshot.slice(0, 2_000)}`,
  );
  return `@${ref}`;
};

// Clicks the first interactive element whose snapshot line matches.
export const clickMatching = async (session, matches, scope) => {
  const snapshot = await session.command(
    'snapshot',
    '-i',
    ...(scope === undefined ? [] : ['-s', scope]),
  );
  await session.click(refIn(snapshot, matches));
};

// Polls until the check answers true (or fails the test).
export const waitUntil = async (label, check, limitMs = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (await check()) return Date.now() - started;
    await sleep(500);
  }
  return assert.fail(`${label} did not happen within ${limitMs} ms`);
};

// Picks an item in the item picker whose button matches, by the text of
// its row, and saves the pick; waits until the picker drawer closed.
export const pickInDrawer = async (session, { picker, scope, text }) => {
  await clickMatching(session, picker, scope);
  await session.command('wait', '--text', text);
  await clickMatching(session, (line) => line.includes(text), '#dialog-outlet');
  await clickMatching(
    session,
    (line) => line.includes('button "Save"'),
    '#dialog-outlet',
  );
  await waitUntil('the picker drawer to close', async () => {
    const open = await session.command(
      'snapshot',
      '-i',
      '-s',
      '#dialog-outlet',
    );
    return !open.includes('heading "Select Item"');
  });
};

// Records the session's network traffic with the text bodies of the
// answers (a HAR), from now until `stopRecording`.
export const startRecording = (session) =>
  session.command('network', 'har', 'start', '--content', 'text');

// Stops the recording and answers its entries. The HAR (it holds session
// tokens) is written into a new temporary directory and removed at once.
export const stopRecording = async (session) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'operations-har-'));
  try {
    const file = path.join(directory, `${session.name}.har`);
    await session.command('network', 'har', 'stop', file);
    const har = JSON.parse(await readFile(file, 'utf8'));
    return har.log.entries;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

// The text of a HAR entry that could carry a payload: the address, the
// request body and the answer's body. The recording embeds every text
// answer (JSON, HTML, scripts, CSV) as text; binary answers (images,
// fonts) are not embedded.
export const entryText = ({ request, response }) =>
  [
    request?.url ?? '',
    request?.postData?.text ?? '',
    response?.content?.text ?? '',
  ].join('\n');

// The ticked checkboxes of a snapshot. Studio's checkbox reports
// checked=false either way; its icon names the state: check_box ticked,
// check_box_outline_blank cleared, indeterminate_check_box never set.
export const tickedBoxes = (snapshot) =>
  snapshot.split('\n').filter((line) => line.includes('checkbox "check_box '));

// The text of an element, or '' when it is absent.
export const textOf = async (session, selector) => {
  const answer = await session.attempt('get', 'text', selector);
  return answer.code === 0 ? answer.stdout : '';
};

// Saves a vault profile (password on stdin) and logs the session in.
export const login = async ({
  base,
  cli,
  email,
  password,
  profile,
  session,
}) => {
  const url = new URL('/admin/login', base).href;
  const saved = await cli.run(
    [
      'auth',
      'save',
      profile,
      '--url',
      url,
      '--username',
      email,
      '--password-stdin',
    ],
    password,
  );
  assert.equal(saved.code, 0, 'the vault profile could not be saved');
  await session.command('--args', '--no-sandbox', 'open', url);
  await session.command('set', 'viewport', '1600', '1000');
  await session.command('auth', 'login', profile);
  await session.command('wait', '--url', '**/admin/**');
  // Directus asks an administrator for a project owner once per login.
  await session.attempt(
    'find',
    'role',
    'button',
    'click',
    '--name',
    'Remind Later',
  );
};

// The session the vault commands (auth save, delete, list) run in when no
// --session is given: they start its daemon.
const vaultSession = () => process.env.AGENT_BROWSER_SESSION || 'default';

// Closes the sessions and deletes the vault profiles, then stops the
// daemons of the sessions the run owns: its own sessions and the vault
// commands' one (whose daemon they start, and which may register only a
// moment later), unless it was already active before the run. Any other
// session, whoever started it, is left alone. The owned sessions must stay
// unlisted for three listings in a row, half a second apart; one still
// listed is closed again every five seconds, for at most 30. Answers what
// the CLI reported, for the receipt.
export const closeBrowser = async (cli, sessions, profiles) => {
  const lines = [];
  for (const session of sessions) {
    const answer = await session.attempt('close');
    lines.push(`close ${session.name}: exit ${answer.code}`);
  }
  for (const profile of profiles) {
    const answer = await cli.run(['auth', 'delete', profile]);
    lines.push(`auth delete ${profile}: exit ${answer.code}`);
  }
  const listed = await cli.run(['auth', 'list']);
  const left = profiles.filter((profile) => listed.stdout.includes(profile));
  lines.push(`profiles left: ${left.length}`);
  const owned = [
    ...new Set([...sessions.map(({ name }) => name), vaultSession()]),
  ].filter((name) => !cli.sessionsBefore.includes(name));
  const closeAll = async (names) => {
    for (const name of names) {
      const answer = await cli.run(['--session', name, 'close']);
      lines.push(`close ${name}: exit ${answer.code}`);
    }
  };
  await closeAll(owned.filter((name) => name === vaultSession()));
  let open = [];
  let quiet = 0;
  for (let attempt = 0; attempt < 60 && quiet < 3; attempt += 1) {
    const active = await activeSessions(cli.run);
    open = owned.filter((name) => active.includes(name));
    quiet = open.length === 0 ? quiet + 1 : 0;
    if (open.length > 0 && attempt % 10 === 0) await closeAll(open);
    await sleep(500);
  }
  lines.push(`sessions of the run left: ${open.length}`);
  assert.deepEqual(open, [], 'every session the run owns is closed');
  return lines;
};

// A random password for a synthetic user; it lives only in this process.
const syntheticPassword = () => `Syn-${randomUUID().replaceAll('-', '')}-9`;

// The role that holds the administrator policy.
const administratorRole = async (target) => {
  const rows = await get(
    target,
    '/access?fields=role&filter[policy][admin_access][_eq]=true&filter[role][_nnull]=true&limit=1',
  );
  assert.ok(rows.length === 1, 'the fixture has an administrator role');
  return rows[0].role;
};

// A synthetic administrator with a password, removed by `remove`.
export const browserUsers = async (target) => {
  const password = syntheticPassword();
  const email = `${restrictedPrefix}${randomUUID()}@example.com`;
  const answer = await post(target, '/users', {
    email,
    password,
    role: await administratorRole(target),
    status: 'active',
  });
  return {
    admin: { email, password },
    remove: () => remove(target, `/users/${answer.data.id}`),
  };
};
