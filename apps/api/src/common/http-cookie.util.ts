import type { Request, Response } from 'express';

export const AUTH_COOKIE_NAMES = {
  accessToken: 'ft360_at',
  refreshToken: 'ft360_rt',
  csrfToken: 'ft360_csrf',
} as const;

export interface CookieSerializeOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax';
  path: string;
  maxAgeSeconds: number;
  domain?: string;
}

export function parseRequestCookies(cookieHeader: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!raw || raw.trim() === '') {
    return {};
  }

  const parsed: Record<string, string> = {};
  for (const segment of raw.split(';')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = segment.slice(0, eqIndex).trim();
    const val = segment.slice(eqIndex + 1).trim();
    if (!key) continue;
    try {
      parsed[key] = decodeURIComponent(val);
    } catch {
      parsed[key] = val;
    }
  }
  return parsed;
}

export function serializeSetCookie(
  name: string,
  value: string,
  opts: CookieSerializeOptions,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.maxAgeSeconds <= 0) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (opts.domain) {
    parts.push(`Domain=${opts.domain}`);
  }
  if (opts.httpOnly) {
    parts.push('HttpOnly');
  }
  if (opts.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function appendSetCookieHeaders(res: Response, cookies: readonly string[]): void {
  const existing = res.getHeader('Set-Cookie');
  const currentList = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === 'string'
      ? [existing]
      : [];
  res.setHeader('Set-Cookie', [...currentList, ...cookies]);
}

export function extractClientIp(req: Request): string | null {
  const candidate = req.ip || req.socket?.remoteAddress || null;
  if (!candidate) return null;
  const trimmed = candidate.trim();
  // Normalize IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1 -> 127.0.0.1 for clean INET storage
  const normalized = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  if (/^[0-9a-fA-F:.]{2,45}$/.test(normalized)) {
    return normalized;
  }
  return null;
}

export function extractUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  const raw = Array.isArray(ua) ? ua[0] : ua;
  if (!raw || raw.trim() === '') return null;
  return raw.trim().slice(0, 512);
}
