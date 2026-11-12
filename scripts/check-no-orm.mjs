#!/usr/bin/env node
/**
 * Zero-ORM & Tenant Database Boundary Policy Scanner
 *
 * Enforces mandatory architectural rules across the monorepo:
 * 1. Prohibits installing Prisma, TypeORM, Drizzle, Sequelize, Knex, MikroORM, Objection.
 * 2. Prohibits importing database/redis drivers ('pg', 'ioredis', 'bullmq') inside apps/web (Next.js).
 * 3. Prohibits instantiating `new Pool(` outside `apps/api/src/database/`.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const PROHIBITED_ORM_PACKAGES = new Set([
  'prisma',
  '@prisma/client',
  'typeorm',
  '@nestjs/typeorm',
  'drizzle-orm',
  'drizzle-kit',
  'sequelize',
  'sequelize-typescript',
  '@nestjs/sequelize',
  'knex',
  'objection',
  '@mikro-orm/core',
  '@mikro-orm/postgresql',
]);

const errors = [];

function checkPackageJson(pkgPath) {
  if (!fs.existsSync(pkgPath)) return;
  const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const section of sections) {
    const deps = raw[section] || {};
    for (const depName of Object.keys(deps)) {
      if (PROHIBITED_ORM_PACKAGES.has(depName)) {
        errors.push(`[ORM PROHIBITED] Package "${depName}" found in ${path.relative(ROOT, pkgPath)} (${section}).`);
      }
    }
  }
}

function checkLockfile(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const packages = raw.packages || {};
  for (const pkgKey of Object.keys(packages)) {
    for (const forbidden of PROHIBITED_ORM_PACKAGES) {
      if (pkgKey === `node_modules/${forbidden}` || pkgKey.endsWith(`/node_modules/${forbidden}`)) {
        errors.push(`[ORM PROHIBITED] Transitive/direct lockfile entry "${pkgKey}" detected in package-lock.json.`);
      }
    }
  }
}

function walkFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, fileList);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      fileList.push(full);
    }
  }
  return fileList;
}

// 1. Check all workspace package.json files + lockfile
checkPackageJson(path.join(ROOT, 'package.json'));
for (const group of ['apps', 'packages']) {
  const groupDir = path.join(ROOT, group);
  if (fs.existsSync(groupDir)) {
    for (const sub of fs.readdirSync(groupDir)) {
      checkPackageJson(path.join(groupDir, sub, 'package.json'));
    }
  }
}
checkLockfile(path.join(ROOT, 'package-lock.json'));

// 2. Ensure Next.js frontend never imports pg, ioredis, or bullmq directly
for (const file of walkFiles(path.join(ROOT, 'apps', 'web', 'src'))) {
  const content = fs.readFileSync(file, 'utf8');
  if (/from\s+['"](pg|ioredis|bullmq)['"]/.test(content) || /require\(['"](pg|ioredis|bullmq)['"]\)/.test(content)) {
    errors.push(`[BOUNDARY VIOLATION] Frontend file ${path.relative(ROOT, file)} imports backend data driver directly.`);
  }
}

// 3. Ensure `new Pool(` or `new pg.Pool(` only occurs inside apps/api/src/database/
const allowedPoolDir = path.normalize(path.join(ROOT, 'apps', 'api', 'src', 'database'));
for (const file of walkFiles(path.join(ROOT, 'apps', 'api', 'src'))) {
  const normalized = path.normalize(file);
  if (!normalized.startsWith(allowedPoolDir)) {
    const content = fs.readFileSync(file, 'utf8');
    if (/new\s+(pg\.)?Pool\s*\(/.test(content)) {
      errors.push(`[POOL GOVERNANCE] Unauthorized pg.Pool instantiation in ${path.relative(ROOT, file)}. Use DatabaseModule / TenantTransactionManager.`);
    }
  }
}

if (errors.length > 0) {
  console.error('Architecture & Zero-ORM Policy Check FAILED:');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log('Architecture & Zero-ORM Policy Check PASSED: 0 ORM packages, strict frontend/backend & pg.Pool boundaries verified.');

