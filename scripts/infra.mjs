#!/usr/bin/env node
/**
 * Infrastructure Lifecycle Manager (`infra:up`, `infra:down`, `infra:ps`)
 *
 * Primary Mode: Docker Compose (`postgres:18-alpine` + `redis:7-alpine`).
 * Fallback Mode (Windows when BIOS/WSL2 virtualization is unavailable):
 *   Automatically provisions an isolated user-space PostgreSQL 18 cluster in
 *   `.local-infra/postgres-data` (on `POSTGRES_HOST_PORT`, never touching any
 *   host Windows PostgreSQL service) + isolated persistent Redis 8 server in
 *   `.local-infra/redis-data`, enforcing identical `ft360_migrator` & `ft360_app`
 *   (`NOBYPASSRLS`, `NOSUPERUSER`) least-privilege roles.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const ROOT = process.cwd();
const LOCAL_INFRA_DIR = path.join(ROOT, '.local-infra');
const PG_DATA_DIR = path.join(LOCAL_INFRA_DIR, 'postgres-data');
const PG_LOG_FILE = path.join(LOCAL_INFRA_DIR, 'postgres.log');
const REDIS_BIN_DIR = path.join(LOCAL_INFRA_DIR, 'redis-bin');
const REDIS_DATA_DIR = path.join(LOCAL_INFRA_DIR, 'redis-data');
const REDIS_PID_FILE = path.join(LOCAL_INFRA_DIR, 'redis.pid');

const REDIS_WIN_ZIP_URL =
  'https://github.com/redis-windows/redis-windows/releases/download/8.10.3/Redis-8.10.3-Windows-x64-msys2.zip';

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  const examplePath = path.join(ROOT, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log('[infra] Created .env from .env.example');
  }
  const vars = { ...process.env };
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (vars[key] === undefined) {
        vars[key] = val;
      }
    }
  }
  return vars;
}

function isDockerDaemonAvailable() {
  const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 4000,
    stdio: 'pipe',
  });
  return res.status === 0;
}

function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function findPgBinDir() {
  const candidates = [
    'C:\\Program Files\\PostgreSQL\\18\\bin',
    'C:\\Program Files\\PostgreSQL\\17\\bin',
    'C:\\Program Files\\PostgreSQL\\16\\bin',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'pg_ctl.exe')) && fs.existsSync(path.join(dir, 'initdb.exe'))) {
      return dir;
    }
  }
  const whereRes = spawnSync('where', ['pg_ctl'], { encoding: 'utf8', stdio: 'pipe' });
  if (whereRes.status === 0 && whereRes.stdout.trim()) {
    return path.dirname(whereRes.stdout.trim().split(/\r?\n/)[0]);
  }
  throw new Error('PostgreSQL binaries (initdb/pg_ctl) not found and Docker Desktop is not running.');
}

function findExecutableRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findExecutableRecursive(full, filename);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function ensureLocalPostgres(env) {
  const pgBin = findPgBinDir();
  const initdb = path.join(pgBin, 'initdb.exe');
  const pgCtl = path.join(pgBin, 'pg_ctl.exe');
  const psql = path.join(pgBin, 'psql.exe');

  const pgPort = Number.parseInt(env.POSTGRES_HOST_PORT || '5434', 10);
  const superUser = env.POSTGRES_SUPERUSER || 'postgres';
  const superPw = env.POSTGRES_SUPERUSER_PASSWORD || 'change_me_local_superuser_pw';
  const dbName = env.POSTGRES_DB || 'ft360_dev';
  const migratorUser = env.DB_MIGRATOR_USER || 'ft360_migrator';
  const migratorPw = env.DB_MIGRATOR_PASSWORD || 'change_me_local_migrator_pw';
  const appUser = env.DB_APP_USER || 'ft360_app';
  const appPw = env.DB_APP_PASSWORD || 'change_me_local_app_pw';

  fs.mkdirSync(LOCAL_INFRA_DIR, { recursive: true });

  if (!fs.existsSync(path.join(PG_DATA_DIR, 'PG_VERSION'))) {
    console.log(`[infra] Initializing isolated PostgreSQL 18 cluster at .local-infra/postgres-data (port ${pgPort})...`);
    const pwFile = path.join(LOCAL_INFRA_DIR, '.pg_super_pw.tmp');
    fs.writeFileSync(pwFile, `${superPw}\n`, 'utf8');
    try {
      const initRes = spawnSync(
        initdb,
        [
          '-D',
          PG_DATA_DIR,
          '-U',
          superUser,
          '-E',
          'UTF8',
          '--locale=C',
          '--auth-host=scram-sha-256',
          '--auth-local=scram-sha-256',
          `--pwfile=${pwFile}`,
        ],
        { stdio: 'inherit' },
      );
      if (initRes.status !== 0) {
        throw new Error(`initdb failed with status ${initRes.status}`);
      }
    } finally {
      if (fs.existsSync(pwFile)) fs.unlinkSync(pwFile);
    }

    fs.appendFileSync(
      path.join(PG_DATA_DIR, 'postgresql.conf'),
      `\n# FT360 isolated local cluster settings\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nmax_connections = 100\n`,
      'utf8',
    );
  }

  const statusRes = spawnSync(pgCtl, ['status', '-D', PG_DATA_DIR], { stdio: 'pipe' });
  if (statusRes.status !== 0) {
    console.log(`[infra] Starting isolated PostgreSQL 18 server on 127.0.0.1:${pgPort}...`);
    // Spawn via PowerShell Start-Process so pg_ctl background child isn't tied to current console pipe handles
    const psStart = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `& '${pgCtl}' -D '${PG_DATA_DIR}' -l '${PG_LOG_FILE}' -w start`,
      ],
      { stdio: 'inherit' },
    );
    if (psStart.status !== 0) {
      throw new Error(`pg_ctl start failed with status ${psStart.status}`);
    }
  } else {
    console.log(`[infra] Isolated PostgreSQL 18 is already running on 127.0.0.1:${pgPort}.`);
  }

  // Ensure database, least-privilege roles (ft360_migrator & ft360_app NOBYPASSRLS), and extensions exist
  const pgEnv = { ...process.env, PGPASSWORD: superPw };
  const dbExistsRes = spawnSync(
    psql,
    ['-h', '127.0.0.1', '-p', String(pgPort), '-U', superUser, '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`],
    { encoding: 'utf8', env: pgEnv },
  );
  if (dbExistsRes.stdout.trim() !== '1') {
    console.log(`[infra] Creating database "${dbName}"...`);
    const createDbRes = spawnSync(
      psql,
      ['-h', '127.0.0.1', '-p', String(pgPort), '-U', superUser, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${dbName};`],
      { stdio: 'inherit', env: pgEnv },
    );
    if (createDbRes.status !== 0) {
      throw new Error(`Failed to create database ${dbName}`);
    }
  }

  const roleSetupSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${migratorUser}') THEN
        CREATE ROLE ${migratorUser} WITH LOGIN PASSWORD '${migratorPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      ELSE
        ALTER ROLE ${migratorUser} WITH LOGIN PASSWORD '${migratorPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appUser}') THEN
        CREATE ROLE ${appUser} WITH LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      ELSE
        ALTER ROLE ${appUser} WITH LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      END IF;
    END
    $$;

    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${dbName} TO ${migratorUser}, ${appUser};
    GRANT USAGE, CREATE ON SCHEMA public TO ${migratorUser};
    GRANT USAGE ON SCHEMA public TO ${appUser};

    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS btree_gist;
  `;

  const roleRes = spawnSync(
    psql,
    ['-h', '127.0.0.1', '-p', String(pgPort), '-U', superUser, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c', roleSetupSql],
    { stdio: 'inherit', env: pgEnv },
  );
  if (roleRes.status !== 0) {
    throw new Error('Failed to provision PostgreSQL least-privilege roles and extensions.');
  }
}

async function ensureLocalRedis(env) {
  const redisPort = Number.parseInt(env.REDIS_PORT || '6379', 10);
  const redisPw = env.REDIS_PASSWORD || 'change_me_local_redis_pw';

  fs.mkdirSync(REDIS_BIN_DIR, { recursive: true });
  fs.mkdirSync(REDIS_DATA_DIR, { recursive: true });

  let redisServerExe = findExecutableRecursive(REDIS_BIN_DIR, 'redis-server.exe');
  if (!redisServerExe) {
    console.log('[infra] Downloading portable Redis 8 server into .local-infra/redis-bin...');
    const zipPath = path.join(LOCAL_INFRA_DIR, 'redis-portable.zip');
    const dlRes = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${REDIS_WIN_ZIP_URL}' -OutFile '${zipPath}' -UseBasicParsing; Expand-Archive -Path '${zipPath}' -DestinationPath '${REDIS_BIN_DIR}' -Force; Remove-Item '${zipPath}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (dlRes.status !== 0) {
      throw new Error('Failed to download/extract portable Redis binary.');
    }
    redisServerExe = findExecutableRecursive(REDIS_BIN_DIR, 'redis-server.exe');
    if (!redisServerExe) {
      throw new Error('redis-server.exe not found after extracting archive.');
    }
  }

  if (await isPortListening(redisPort)) {
    console.log(`[infra] Redis is already listening on 127.0.0.1:${redisPort}.`);
    return;
  }

  console.log(`[infra] Starting persistent Redis server on 127.0.0.1:${redisPort}...`);
  const argList = [
    '--bind',
    '127.0.0.1',
    '--port',
    String(redisPort),
    '--dir',
    '.',
    '--appendonly',
    'yes',
    '--appendfsync',
    'everysec',
    '--requirepass',
    redisPw,
  ]
    .map((a) => `'${a}'`)
    .join(',');

  const startCmd = `$p = Start-Process -FilePath '${redisServerExe}' -ArgumentList @(${argList}) -WorkingDirectory '${REDIS_DATA_DIR}' -PassThru -WindowStyle Hidden; Set-Content -Path '${REDIS_PID_FILE}' -Value $p.Id`;
  const startRes = spawnSync('powershell', ['-NoProfile', '-Command', startCmd], { stdio: 'inherit' });
  if (startRes.status !== 0) {
    throw new Error('Failed to launch redis-server.exe');
  }

  for (let i = 0; i < 25; i++) {
    if (await isPortListening(redisPort)) {
      console.log(`[infra] Redis ready on 127.0.0.1:${redisPort}.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Redis did not start listening on port ${redisPort} within timeout.`);
}

async function stopLocalInfra() {
  if (fs.existsSync(path.join(PG_DATA_DIR, 'PG_VERSION'))) {
    try {
      const pgBin = findPgBinDir();
      const pgCtl = path.join(pgBin, 'pg_ctl.exe');
      spawnSync(pgCtl, ['stop', '-D', PG_DATA_DIR, '-m', 'fast'], { stdio: 'inherit' });
    } catch {
      // Ignore if already stopped
    }
  }

  if (fs.existsSync(REDIS_PID_FILE)) {
    const pid = fs.readFileSync(REDIS_PID_FILE, 'utf8').trim();
    if (pid) {
      spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
    }
    fs.unlinkSync(REDIS_PID_FILE);
    console.log('[infra] Stopped local Redis server.');
  }
}

async function main() {
  const action = process.argv[2] || 'up';
  const env = loadDotEnv();
  const pgPort = Number.parseInt(env.POSTGRES_HOST_PORT || '5434', 10);
  const redisPort = Number.parseInt(env.REDIS_PORT || '6379', 10);

  if (action === 'up') {
    if (isDockerDaemonAvailable()) {
      console.log('[infra] Docker Engine detected. Starting postgres & redis via Docker Compose...');
      const res = spawnSync('docker', ['compose', 'up', '-d', 'postgres', 'redis'], { stdio: 'inherit' });
      if (res.status !== 0) process.exit(res.status ?? 1);
      return;
    }

    if (process.platform !== 'win32') {
      console.error('[infra] Docker daemon is not running. Start Docker and retry.');
      process.exit(1);
    }

    console.log(
      '[infra] Docker Engine unavailable (BIOS/WSL2 virtualization disabled). Activating isolated local PostgreSQL 18 + Redis 8 runtime...',
    );
    await ensureLocalPostgres(env);
    await ensureLocalRedis(env);
    console.log(`[infra] Infrastructure READY (PostgreSQL 18 -> 127.0.0.1:${pgPort}, Redis -> 127.0.0.1:${redisPort}).`);
  } else if (action === 'down') {
    if (isDockerDaemonAvailable()) {
      spawnSync('docker', ['compose', 'stop', 'postgres', 'redis'], { stdio: 'inherit' });
    }
    if (process.platform === 'win32') {
      await stopLocalInfra();
    }
  } else if (action === 'ps') {
    if (isDockerDaemonAvailable()) {
      spawnSync('docker', ['compose', 'ps'], { stdio: 'inherit' });
      return;
    }
    const pgUp = await isPortListening(pgPort);
    const redisUp = await isPortListening(redisPort);
    console.table([
      { service: 'postgres-18 (isolated local)', endpoint: `127.0.0.1:${pgPort}`, status: pgUp ? 'RUNNING' : 'STOPPED' },
      { service: 'redis-8 (isolated local)', endpoint: `127.0.0.1:${redisPort}`, status: redisUp ? 'RUNNING' : 'STOPPED' },
    ]);
  } else if (action === 'daemon') {
    console.log('[infra] Starting persistent local PostgreSQL 18 + Redis 8 supervisor...');
    await ensureLocalPostgres(env);
    await ensureLocalRedis(env);
    console.log(`[infra] Supervisor active (PostgreSQL 18 -> 127.0.0.1:${pgPort}, Redis -> 127.0.0.1:${redisPort}).`);

    const shutdown = async () => {
      console.log('[infra] Stopping supervised PostgreSQL + Redis...');
      await stopLocalInfra();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    // Keep supervisor process alive and auto-heal if either service stops
    setInterval(async () => {
      try {
        if (!(await isPortListening(pgPort))) {
          await ensureLocalPostgres(env);
        }
        if (!(await isPortListening(redisPort))) {
          await ensureLocalRedis(env);
        }
      } catch (err) {
        console.error('[infra] Auto-heal warning:', err instanceof Error ? err.message : err);
      }
    }, 10000);
  } else {
    console.error(`Unknown infra command "${action}". Expected: up | down | ps | daemon`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[infra] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

