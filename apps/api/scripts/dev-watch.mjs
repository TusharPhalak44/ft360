#!/usr/bin/env node
/**
 * NestJS Watch-Mode Runner using Official TypeScript Compiler (`tsc --watch`)
 * Preserves full `emitDecoratorMetadata` support and avoids platform-specific esbuild binary issues.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');
const isWindows = process.platform === 'win32';

let serverProc = null;
let shuttingDown = false;

function stopServer() {
  if (!serverProc?.pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      serverProc.kill('SIGTERM');
    } catch {
      // Ignore
    }
  }
  serverProc = null;
}

function restartServer() {
  if (shuttingDown) return;
  stopServer();
  serverProc = spawn(process.execPath, [path.resolve('dist/main.js')], {
    stdio: 'inherit',
    env: process.env,
  });
}

const tscWatch = spawn(
  process.execPath,
  [tscBin, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);

let buffer = '';
tscWatch.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  buffer += text;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (/Found 0 errors\. Watching for file changes\./.test(line)) {
      restartServer();
    }
  }
});

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopServer();
  if (tscWatch.pid) {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(tscWatch.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      tscWatch.kill('SIGTERM');
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
