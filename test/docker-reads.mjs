import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The read-only Docker commands the fixture suites run to tie a named
// container to the isolated target before they touch it: the ports it
// publishes (`docker port`), its networks (`docker inspect`) and one named,
// non-secret setting of its environment (`printenv`). Nothing here starts,
// stops or changes a container.

const runCommand = promisify(execFile);
const trailingNewline = /\n$/u;

export const dockerReads = {
  // The container's networks, as `docker inspect` prints them.
  networks: async (container) => {
    const { stdout } = await runCommand('docker', [
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      container,
    ]);
    return JSON.parse(stdout);
  },
  // `docker port <container>`: one "inner/tcp -> host:port" line per port.
  ports: async (container) => {
    const { stdout } = await runCommand('docker', ['port', container]);
    return stdout;
  },
  // One setting of the container's environment, or null when it is unset
  // (printenv exits 1). Callers read only named, non-secret settings.
  setting: async (container, name) => {
    try {
      const { stdout } = await runCommand('docker', [
        'exec',
        container,
        'printenv',
        name,
      ]);
      return stdout.replace(trailingNewline, '');
    } catch (error) {
      if (error?.code === 1) return null;
      throw error;
    }
  },
};
