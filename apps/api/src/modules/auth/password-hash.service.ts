import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';

export interface PasswordValidationIssue {
  field: string;
  issue: string;
}

@Injectable()
export class PasswordHashService implements OnModuleInit {
  private dummyHashPromise: Promise<string> | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppEnvConfig) {}

  async onModuleInit(): Promise<void> {
    await this.getDummyHash();
  }

  validatePasswordPolicy(password: unknown, email?: string): void {
    const issues: PasswordValidationIssue[] = [];

    if (typeof password !== 'string') {
      throw new BadRequestException({
        code: 'PASSWORD_POLICY_VIOLATION',
        message: 'Password does not satisfy security policy requirements.',
        details: [{ field: 'password', issue: 'Password must be a string.' }],
      });
    }

    if (password.length < 12) {
      issues.push({
        field: 'password',
        issue: 'Password must be at least 12 characters long.',
      });
    }
    if (password.length > 128) {
      issues.push({
        field: 'password',
        issue: 'Password must not exceed 128 characters.',
      });
    }
    if (password.trim().length === 0) {
      issues.push({
        field: 'password',
        issue: 'Password cannot consist solely of whitespace.',
      });
    }
    if (!/[A-Z]/.test(password)) {
      issues.push({
        field: 'password',
        issue: 'Password must include at least one uppercase letter.',
      });
    }
    if (!/[a-z]/.test(password)) {
      issues.push({
        field: 'password',
        issue: 'Password must include at least one lowercase letter.',
      });
    }
    if (!/[0-9]/.test(password)) {
      issues.push({
        field: 'password',
        issue: 'Password must include at least one numeric digit.',
      });
    }
    if (!/[^A-Za-z0-9\s]/.test(password)) {
      issues.push({
        field: 'password',
        issue: 'Password must include at least one special symbol.',
      });
    }

    if (email && email.trim() !== '') {
      const normalizedEmail = email.trim().toLowerCase();
      const lowerPw = password.toLowerCase();
      if (lowerPw === normalizedEmail) {
        issues.push({
          field: 'password',
          issue: 'Password must not match your email address.',
        });
      }
    }

    if (issues.length > 0) {
      throw new BadRequestException({
        code: 'PASSWORD_POLICY_VIOLATION',
        message: 'Password does not satisfy security policy requirements.',
        details: issues,
      });
    }
  }

  async hashPassword(plainPassword: string): Promise<string> {
    this.validatePasswordPolicy(plainPassword);
    return argon2.hash(plainPassword, {
      type: argon2.argon2id,
      memoryCost: this.config.auth.argon2MemoryCostKiB,
      timeCost: this.config.auth.argon2TimeCost,
      parallelism: this.config.auth.argon2Parallelism,
      hashLength: 32,
      salt: randomBytes(16),
    });
  }

  /**
   * Verifies `plainPassword` against `storedHash` if present, or executes a full
   * Argon2id verification against a precomputed startup dummy hash when `storedHash`
   * is null/empty to prevent timing-based account enumeration.
   */
  async verifyPasswordConstantTime(
    storedHash: string | null | undefined,
    plainPassword: string,
  ): Promise<boolean> {
    // Bound max length before hashing to prevent multi-megabyte CPU exhaustion payloads
    if (typeof plainPassword !== 'string' || plainPassword.length === 0 || plainPassword.length > 128) {
      const dummy = await this.getDummyHash();
      await argon2.verify(dummy, 'invalid-length-guard-probe');
      return false;
    }

    if (!storedHash || !storedHash.startsWith('$argon2id$')) {
      const dummy = await this.getDummyHash();
      await argon2.verify(dummy, plainPassword);
      return false;
    }

    try {
      return await argon2.verify(storedHash, plainPassword);
    } catch {
      return false;
    }
  }

  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = argon2.hash(randomBytes(24).toString('hex'), {
        type: argon2.argon2id,
        memoryCost: this.config.auth.argon2MemoryCostKiB,
        timeCost: this.config.auth.argon2TimeCost,
        parallelism: this.config.auth.argon2Parallelism,
        hashLength: 32,
        salt: randomBytes(16),
      });
    }
    return this.dummyHashPromise;
  }
}
