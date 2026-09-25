import assert from 'node:assert/strict';
import path from 'node:path';

import brandingSettings from '../directus/branding/settings.json' with { type: 'json' };
import { publishAssetsFlowId } from '../src/flows/publish-public-assets.js';
import {
  browserSession,
  closeBrowser,
  login,
  requireBrowser,
} from './operations-browser-helpers.mjs';
import { renamedSuffix } from './restore-project.mjs';

// The restored project in a real browser (restore.integration.mjs, when
// DIRECTUS_RESTORE_SCREENSHOTS names a directory): the branded login page
// before anyone signs in, then, signed in through a vault profile as the
// user whose password was set before the backup (the password goes to the
// CLI on stdin only), the publish Flow with its Studio edit and the
// bookmark listing the course the source edit renamed. Each page must
// show its text before it is captured. The session is closed and the
// profile deleted whatever happens.

const bookmarkName = 'Synthetic restore bookmark';
const editedName = 'Claim publication (edited in Studio)';

const shows = async (session, text, file) => {
  await session.command('wait', '--text', text);
  await session.command('wait', '--load', 'networkidle');
  await session.command('screenshot', file);
};

export const showsRestoredStudio = async ({ state, t, target }) => {
  const directory = process.env.DIRECTUS_RESTORE_SCREENSHOTS ?? '';
  assert.ok(path.isAbsolute(directory), 'screenshots need an absolute path');
  const cli = await requireBrowser();
  const session = browserSession(cli, `restore-${String(process.pid)}`);
  const profile = `restore-admin-${String(process.pid)}`;
  const files = {
    bookmark: path.join(directory, 'restore-03-bookmark.png'),
    flow: path.join(directory, 'restore-02-edited-flow.png'),
    login: path.join(directory, 'restore-01-branded-login.png'),
  };
  try {
    await session.command(
      '--args',
      '--no-sandbox',
      'open',
      new URL('/admin/login', target.base).href,
    );
    await session.command('set', 'viewport', '1600', '1000');
    await shows(session, brandingSettings.project_name, files.login);
    await session.command('close');
    await login({
      base: target.base,
      cli,
      email: state.login.email,
      password: state.login.password,
      profile,
      session,
    });
    await session.command(
      'open',
      new URL(`/admin/settings/flows/${publishAssetsFlowId}`, target.base).href,
    );
    await shows(session, editedName, files.flow);
    await session.command(
      'open',
      new URL(
        `/admin/content/courses?bookmark=${String(state.presetId)}`,
        target.base,
      ).href,
    );
    await session.command('wait', '--text', bookmarkName);
    await shows(session, renamedSuffix, files.bookmark);
  } finally {
    const closed = await closeBrowser(cli, [session], [profile]);
    t.diagnostic(closed.join('; '));
  }
  t.diagnostic(
    `screenshots: ${Object.values(files)
      .map((file) => path.basename(file))
      .join(', ')}`,
  );
};
