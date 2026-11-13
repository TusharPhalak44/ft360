import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import {
  AUTH_COOKIE_NAMES,
  appendSetCookieHeaders,
  serializeSetCookie,
} from '../../common/http-cookie.util';
import { isValidUuid } from '../../common/uuid.util';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';

export interface AccessJwtClaims {
  sub: string;
  sid: string;
  tid: string | null;
  mid: string | null;
  padmin: boolean;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface IssueAccessJwtInput {
  userId: string;
  sessionId: string;
  activeTenantId: string | null;
  activeMembershipId: string | null;
  isPlatformSuperAdmin: boolean;
}

export interface GeneratedOpaqueSecret {
  rawToken: string;
  tokenHashHex: string;
}

@Injectable()
export class TokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppEnvConfig) {}

  generateOpaqueSecret(): GeneratedOpaqueSecret {
    const rawToken = randomBytes(32).toString('base64url');
    return {
      rawToken,
      tokenHashHex: this.sha256Hex(rawToken),
    };
  }

  sha256Hex(rawToken: string): string {
    return createHash('sha256').update(rawToken, 'utf8').digest('hex');
  }

  signAccessToken(input: IssueAccessJwtInput): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: AccessJwtClaims = {
      sub: input.userId.trim().toLowerCase(),
      sid: input.sessionId.trim().toLowerCase(),
      tid: input.activeTenantId ? input.activeTenantId.trim().toLowerCase() : null,
      mid: input.activeMembershipId ? input.activeMembershipId.trim().toLowerCase() : null,
      padmin: Boolean(input.isPlatformSuperAdmin),
      jti: randomUUID(),
      iss: this.config.auth.jwtIssuer,
      aud: this.config.auth.jwtAudience,
      iat: nowSec,
      exp: nowSec + this.config.auth.accessTokenTtlSeconds,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = this.computeHmacBase64Url(signingInput);

    return `${signingInput}.${signature}`;
  }

  verifyAccessToken(token: string): AccessJwtClaims {
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096) {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token is missing or malformed.',
      });
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token format is invalid.',
      });
    }

    const [encodedHeader, encodedPayload, providedSig] = parts;
    const expectedSig = this.computeHmacBase64Url(`${encodedHeader}.${encodedPayload}`);

    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token signature verification failed.',
      });
    }

    let header: { alg?: unknown; typ?: unknown };
    let claims: Partial<AccessJwtClaims>;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
        alg?: unknown;
        typ?: unknown;
      };
      claims = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<AccessJwtClaims>;
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token payload could not be decoded.',
      });
    }

    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Unsupported JWT algorithm.',
      });
    }

    if (
      claims.iss !== this.config.auth.jwtIssuer ||
      claims.aud !== this.config.auth.jwtAudience ||
      !isValidUuid(claims.sub) ||
      !isValidUuid(claims.sid) ||
      !isValidUuid(claims.jti) ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number'
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token claims are invalid.',
      });
    }

    if (claims.tid !== null && claims.tid !== undefined && !isValidUuid(claims.tid)) {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token tenant claim is malformed.',
      });
    }
    if (claims.mid !== null && claims.mid !== undefined && !isValidUuid(claims.mid)) {
      throw new UnauthorizedException({
        code: 'INVALID_ACCESS_TOKEN',
        message: 'Access token membership claim is malformed.',
      });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSec) {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_EXPIRED',
        message: 'Access token has expired.',
      });
    }

    return {
      sub: claims.sub.trim().toLowerCase(),
      sid: claims.sid.trim().toLowerCase(),
      tid: claims.tid ? claims.tid.trim().toLowerCase() : null,
      mid: claims.mid ? claims.mid.trim().toLowerCase() : null,
      padmin: Boolean(claims.padmin),
      jti: claims.jti.trim().toLowerCase(),
      iss: claims.iss,
      aud: claims.aud,
      iat: claims.iat,
      exp: claims.exp,
    };
  }

  setSessionCookies(
    res: Response,
    tokens: {
      accessToken: string;
      refreshToken?: string;
      csrfToken?: string;
    },
  ): void {
    const cookies: string[] = [
      serializeSetCookie(AUTH_COOKIE_NAMES.accessToken, tokens.accessToken, {
        httpOnly: true,
        secure: this.config.auth.cookieSecure,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: this.config.auth.accessTokenTtlSeconds,
        domain: this.config.auth.cookieDomain,
      }),
    ];

    if (tokens.refreshToken !== undefined) {
      cookies.push(
        serializeSetCookie(AUTH_COOKIE_NAMES.refreshToken, tokens.refreshToken, {
          httpOnly: true,
          secure: this.config.auth.cookieSecure,
          sameSite: 'Strict',
          path: '/api/v1/auth',
          maxAgeSeconds: this.config.auth.refreshIdleTtlSeconds,
          domain: this.config.auth.cookieDomain,
        }),
      );
    }

    if (tokens.csrfToken !== undefined) {
      cookies.push(
        serializeSetCookie(AUTH_COOKIE_NAMES.csrfToken, tokens.csrfToken, {
          httpOnly: false,
          secure: this.config.auth.cookieSecure,
          sameSite: 'Lax',
          path: '/',
          maxAgeSeconds: this.config.auth.refreshIdleTtlSeconds,
          domain: this.config.auth.cookieDomain,
        }),
      );
    }

    appendSetCookieHeaders(res, cookies);
  }

  setPreAuthCsrfCookie(res: Response, csrfToken: string): void {
    appendSetCookieHeaders(res, [
      serializeSetCookie(AUTH_COOKIE_NAMES.csrfToken, csrfToken, {
        httpOnly: false,
        secure: this.config.auth.cookieSecure,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 900,
        domain: this.config.auth.cookieDomain,
      }),
    ]);
  }

  clearSessionCookies(res: Response): void {
    const cleared = [
      serializeSetCookie(AUTH_COOKIE_NAMES.accessToken, '', {
        httpOnly: true,
        secure: this.config.auth.cookieSecure,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 0,
        domain: this.config.auth.cookieDomain,
      }),
      serializeSetCookie(AUTH_COOKIE_NAMES.refreshToken, '', {
        httpOnly: true,
        secure: this.config.auth.cookieSecure,
        sameSite: 'Strict',
        path: '/api/v1/auth',
        maxAgeSeconds: 0,
        domain: this.config.auth.cookieDomain,
      }),
      serializeSetCookie(AUTH_COOKIE_NAMES.csrfToken, '', {
        httpOnly: false,
        secure: this.config.auth.cookieSecure,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 0,
        domain: this.config.auth.cookieDomain,
      }),
    ];
    appendSetCookieHeaders(res, cleared);
  }

  private computeHmacBase64Url(signingInput: string): string {
    return createHmac('sha256', this.config.auth.jwtSecret)
      .update(signingInput, 'utf8')
      .digest('base64url');
  }
}
