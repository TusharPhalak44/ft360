import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppEnvConfig } from '../config/env.config';
import { IS_PUBLIC_ROUTE_KEY } from './auth.decorators';
import { AUTH_COOKIE_NAMES, parseRequestCookies } from './http-cookie.util';
import type { RequestWithAuthSession } from './jwt-auth.guard';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_SEC_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);
const FORM_CSRF_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

/**
 * Global CSRF & Login-CSRF Protection Policy (`APP_GUARD`, executed after `JwtAuthGuard`):
 *
 * 1. Safe read-only methods (`GET`, `HEAD`, `OPTIONS`) pass without mutation token checks.
 * 2. Explicit `Authorization: Bearer <token>` API clients pass when not relying on session cookies.
 * 3. Browser Fetch Metadata (`Sec-Fetch-Site: cross-site`) is rejected across ALL state-changing routes.
 * 4. `Origin` and `Referer` headers, whenever present, are strictly parsed and validated against
 *    `corsAllowedOrigins` (`Origin: null`, empty headers, malformed URLs, and untrusted origins -> 403).
 * 5. All non-`@Public()` cookie-authenticated endpoints (plus `@Public()` cookie rotation/revocation
 *    routes `/auth/refresh` and `/auth/logout`) require constant-time `ft360_csrf === X-CSRF-Token`
 *    double-submit equality AND `req.csrfVerifiedBySession !== false`.
 * 6. Pre-authentication `@Public()` state-changing endpoints (`/auth/login`, `/auth/register`,
 *    `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password`)
 *    are hardened against Login-CSRF:
 *      - Cross-site HTML form `Content-Type`s are rejected (`application/json` required).
 *      - Any supplied `X-CSRF-Token` must match `ft360_csrf` cookie in constant time.
 *      - Browser requests (identified by `Sec-Fetch-*`, `Cookie`, or `Mozilla/` UA) MUST present
 *        either a verified trusted `Origin`/`Referer` or a valid pre-auth CSRF token pair (`GET /api/v1/auth/csrf`).
 *      - Non-browser JSON API clients without ambient cookies remain supported.
 */
@Injectable()
export class CsrfProtectionGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
    @Optional() private readonly reflector?: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithAuthSession>();
    const method = (req.method || 'GET').toUpperCase();

    if (SAFE_HTTP_METHODS.has(method)) {
      return true;
    }

    const cookies = parseRequestCookies(req.headers.cookie);
    const hasSessionCookies =
      Boolean(cookies[AUTH_COOKIE_NAMES.accessToken]?.trim()) ||
      Boolean(cookies[AUTH_COOKIE_NAMES.refreshToken]?.trim());

    // Explicit Authorization: Bearer clients that are not relying on cookie transport
    const authHeader = req.headers.authorization;
    const rawBearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (
      req.authSession?.authTransport === 'bearer' ||
      (!hasSessionCookies && typeof rawBearer === 'string' && /^Bearer\s+\S+/i.test(rawBearer))
    ) {
      return true;
    }

    // Enforce Fetch Metadata defense across all browser state-changing requests
    this.verifySecFetchSite(req);

    // Strictly validate Origin / Referer if present (returns true when a trusted origin was verified)
    const originVerified = this.verifyOriginOrReferer(req);

    const isPublicRoute =
      this.reflector?.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    const rawPath = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
    const isCookieLifecyclePublicRoute =
      rawPath.endsWith('/auth/refresh') || rawPath.endsWith('/auth/logout');

    if (!isPublicRoute || isCookieLifecyclePublicRoute || req.authSession?.authTransport === 'cookie') {
      this.assertDoubleSubmitToken(req, cookies);
      if (req.csrfVerifiedBySession === false) {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'CSRF token does not match active server session.',
        });
      }
      return true;
    }

    // Pre-authentication @Public() state-changing route (e.g. POST /api/v1/auth/login):
    this.rejectFormEncodedContentType(req);

    const csrfHeaderRaw = req.headers['x-csrf-token'];
    const csrfHeader = Array.isArray(csrfHeaderRaw) ? csrfHeaderRaw[0] : csrfHeaderRaw;
    let preAuthCsrfVerified = false;
    if (csrfHeader !== undefined) {
      this.assertDoubleSubmitToken(req, cookies);
      preAuthCsrfVerified = true;
    }

    if (this.isBrowserContextRequest(req) && !originVerified && !preAuthCsrfVerified) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message:
          'Browser authentication requests require a trusted Origin/Referer header or pre-authentication CSRF token.',
      });
    }

    return true;
  }

  private assertDoubleSubmitToken(
    req: RequestWithAuthSession,
    cookies: Record<string, string>,
  ): void {
    const cookieCsrf = cookies[AUTH_COOKIE_NAMES.csrfToken];
    const headerRaw = req.headers['x-csrf-token'];
    const headerCsrf = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;

    if (
      typeof cookieCsrf !== 'string' ||
      cookieCsrf.trim() === '' ||
      typeof headerCsrf !== 'string' ||
      headerCsrf.trim() === ''
    ) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing required CSRF protection token.',
      });
    }

    const cookieBuf = Buffer.from(cookieCsrf.trim(), 'utf8');
    const headerBuf = Buffer.from(headerCsrf.trim(), 'utf8');
    if (cookieBuf.length !== headerBuf.length || !timingSafeEqual(cookieBuf, headerBuf)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token validation failed.',
      });
    }
  }

  private verifySecFetchSite(req: RequestWithAuthSession): void {
    const rawHeader = req.headers['sec-fetch-site'];
    const secFetchSite = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim().toLowerCase();
    if (secFetchSite && !ALLOWED_SEC_FETCH_SITES.has(secFetchSite)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: `Cross-site browser request blocked by Fetch Metadata policy (Sec-Fetch-Site: ${secFetchSite}).`,
      });
    }
  }

  private verifyOriginOrReferer(req: RequestWithAuthSession): boolean {
    const allowed = this.getNormalizedAllowedOrigins();

    if (req.headers.origin !== undefined) {
      const originHeader = req.headers.origin;
      const rawOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
      const trimmed = rawOrigin?.trim() ?? '';
      if (trimmed === '' || trimmed.toLowerCase() === 'null') {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Missing or opaque null Origin header rejected by CSRF policy.',
        });
      }

      let parsedOrigin: string;
      try {
        const url = new URL(trimmed);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== trimmed.replace(/\/+$/, '')) {
          throw new Error('Origin contains unexpected path or scheme');
        }
        parsedOrigin = url.origin.toLowerCase();
      } catch {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Malformed Origin header rejected by CSRF policy.',
        });
      }

      if (!allowed.has(parsedOrigin)) {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Cross-site request origin is not permitted.',
        });
      }
      return true;
    }

    if (req.headers.referer !== undefined) {
      const refererHeader = req.headers.referer;
      const rawReferer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
      const trimmed = rawReferer?.trim() ?? '';
      if (trimmed === '') {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Empty Referer header rejected by CSRF policy.',
        });
      }

      let refererOrigin: string;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Invalid Referer scheme');
        }
        refererOrigin = parsed.origin.toLowerCase();
      } catch {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Malformed Referer header rejected by CSRF policy.',
        });
      }

      if (!allowed.has(refererOrigin)) {
        throw new ForbiddenException({
          code: 'CSRF_TOKEN_INVALID',
          message: 'Cross-site Referer origin is not permitted.',
        });
      }
      return true;
    }

    return false;
  }

  private rejectFormEncodedContentType(req: RequestWithAuthSession): void {
    const ctHeader = req.headers['content-type'];
    const rawCt = (Array.isArray(ctHeader) ? ctHeader[0] : ctHeader)?.trim().toLowerCase() ?? '';
    if (!rawCt) {
      return;
    }
    const mediaType = rawCt.split(';')[0].trim();
    if (FORM_CSRF_CONTENT_TYPES.includes(mediaType)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Form-encoded cross-site content types are rejected; use application/json.',
      });
    }
  }

  private isBrowserContextRequest(req: RequestWithAuthSession): boolean {
    if (
      req.headers['sec-fetch-mode'] !== undefined ||
      req.headers['sec-fetch-site'] !== undefined ||
      req.headers['sec-fetch-dest'] !== undefined
    ) {
      return true;
    }
    const rawCookie = req.headers.cookie;
    if (typeof rawCookie === 'string' && rawCookie.trim() !== '') {
      return true;
    }
    const uaHeader = req.headers['user-agent'];
    const ua = (Array.isArray(uaHeader) ? uaHeader[0] : uaHeader) ?? '';
    return /^Mozilla\//i.test(ua.trim());
  }

  private getNormalizedAllowedOrigins(): Set<string> {
    const out = new Set<string>();
    for (const entry of this.config.corsAllowedOrigins) {
      const cleaned = entry.trim().replace(/\/+$/, '').toLowerCase();
      if (cleaned) {
        out.add(cleaned);
      }
    }
    return out;
  }
}
