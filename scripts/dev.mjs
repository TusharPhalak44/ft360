#!/usr/bin/env node
/**
 * Unified Monorepo Development Launcher (`npm run dev`)
 *
 * 1. Builds `@ft360/shared-types` so workspace contracts are up-to-date.
 * 2. Starts `@ft360/api` (NestJS on :4000) and `@ft360/web` (Next.js on :3000) concurrently.
 * 3. Streams prefixed logs and cleanly terminates child process trees on Ctrl+C.
 */
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

console.log('[dev] Building @ft360/shared-types...');
const buildShared = spawnSync(npmCmd, ['run', 'build', '--workspace=@ft360/shared-types'], {
  stdio: 'inherit',
  shell: isWindows,
});

if (buildShared.status !== 0) {
  process.exit(buildShared.status ?? 1);
}

console.log('[dev] Starting NestJS Backend (@ft360/api) and Next.js Frontend (@ft360/web)...');

const children = [];
let shuttingDown = false;

function prefixStream(stream, tag, colorCode, target) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      target.write(`\x1b[${colorCode}m[${tag}]\x1b[0m ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      target.write(`\x1b[${colorCode}m[${tag}]\x1b[0m ${buffer}\n`);
    }
  });
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already exited child
    }
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev] Shutting down development services...');
  for (const child of children) {
    killProcessTree(child);
  }
  process.exit(exitCode);
}

function startService(scriptName, tag, colorCode) {
  const child = spawn(npmCmd, ['run', scriptName], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  children.push(child);
  prefixStream(child.stdout, tag, colorCode, process.stdout);
  prefixStream(child.stderr, tag, colorCode, process.stderr);

  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`[dev] Service [${tag}] exited unexpectedly with code ${code}.`);
      shutdown(code);
    }
  });

  return child;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

startService('dev:api', 'api', '36');
startService('dev:web', 'web', '35');

