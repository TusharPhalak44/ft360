import type {
  ApiErrorResponse,
  ApiFieldError,
  ApiSuccessResponse,
  AuthAuditLogEntry,
  AuthMeResponsePayload,
  AuthSessionSummary,
  LoginResponsePayload,
  PlatformAuthOverviewPayload,
  ProductBrandingConfig,
  RegisterUserResponsePayload,
  SelectOrganizationResponsePayload,
  SystemHealthStatus,
  WorkspaceBoundaryContextPayload,
} from '@ft360/shared-types';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string;
  readonly details?: ApiFieldError[];
  readonly retryAfterSeconds?: number;

  constructor(params: {
    message: string;
    code: string;
    status: number;
    correlationId: string;
    details?: ApiFieldError[];
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.code = params.code;
    this.status = params.status;
    this.correlationId = params.correlationId;
    this.details = params.details;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export function getApiBaseUrl(): string {
  const configured = (
    process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000/api/v1'
  ).replace(/\/+$/, '');

  if (typeof window !== 'undefined') {
    try {
      const parsed = new URL(configured);
      const browserHost = window.location.hostname;
      const isLoopbackBrowser = browserHost === 'localhost' || browserHost === '127.0.0.1';
      const isLoopbackApi = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (isLoopbackBrowser && isLoopbackApi && parsed.hostname !== browserHost) {
        parsed.hostname = browserHost;
        return parsed.toString().replace(/\/+$/, '');
      }
    } catch {
      return configured;
    }
  }
  return configured;
}

export function readBrowserCsrfCookie(): string | null {
  if (typeof document === 'undefined' || !document.cookie) {
    return null;
  }
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'ft360_csrf') {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function ensureBrowserCsrfToken(baseUrl: string): Promise<string | null> {
  const existing = readBrowserCsrfCookie();
  if (existing) {
    return existing;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const res = await fetch(`${baseUrl}/auth/csrf`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      return readBrowserCsrfCookie();
    }
    const payload = (await res.json().catch(() => null)) as
      | ApiSuccessResponse<{ csrfToken: string }>
      | null;
    if (payload && payload.success && payload.data?.csrfToken) {
      return payload.data.csrfToken;
    }
  } catch {
    // Fall back to cookie / Origin check if network fails
  }
  return readBrowserCsrfCookie();
}

/**
 * Centralized REST API client for communicating with the authoritative NestJS backend.
 * Note: Never attaches client-spoofed `tenant_id` headers or query parameters;
 * tenant context is resolved strictly by the backend from verified session credentials.
 */
export async function apiRequest<T>(
  endpointPath: string,
  init?: RequestInit & { includeCredentials?: boolean },
): Promise<{ data: T; correlationId: string }> {
  const baseUrl = getApiBaseUrl();
  const cleanPath = endpointPath.replace(/^\/+/, '');
  const url = `${baseUrl}/${cleanPath}`;
  const method = (init?.method || 'GET').toUpperCase();
  const csrfToken =
    MUTATING_HTTP_METHODS.has(method) && cleanPath !== 'auth/csrf'
      ? await ensureBrowserCsrfToken(baseUrl)
      : null;

  const response = await fetch(url, {
    ...init,
    credentials: init?.includeCredentials ? 'include' : init?.credentials,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  const headerCorrelationId = response.headers.get('x-correlation-id') || 'unavailable';
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

  const payload = (await response.json().catch(() => null)) as
    | ApiSuccessResponse<T>
    | ApiErrorResponse
    | null;

  if (!response.ok || !payload || payload.success === false) {
    const errPayload = payload && payload.success === false ? payload : null;
    throw new ApiClientError({
      message: errPayload?.error.message ?? `API request failed with status ${response.status}`,
      code: errPayload?.error.code ?? 'API_REQUEST_FAILED',
      status: response.status,
      correlationId: errPayload?.meta.correlationId ?? headerCorrelationId,
      details: errPayload?.error.details,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    });
  }

  return {
    data: payload.data,
    correlationId: payload.meta.correlationId,
  };
}

export const foundationApi = {
  getBranding: () => apiRequest<ProductBrandingConfig>('/public/branding'),
  getSystemHealth: () => apiRequest<SystemHealthStatus>('/health'),
};

export interface DevOutboxPreviewDto {
  kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
  recipientEmail: string;
  actionUrl: string;
  rawToken: string;
  enqueuedAt: string;
}

export const authApi = {
  register: (input: { fullName: string; email: string; password: string; phoneE164?: string }) =>
    apiRequest<RegisterUserResponsePayload>('/auth/register', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify(input),
    }),

  verifyEmail: (token: string) =>
    apiRequest<{ verified: true }>('/auth/verify-email', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({ token }),
    }),

  resendVerification: (email: string) =>
    apiRequest<{ accepted: true; message: string }>('/auth/resend-verification', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({ email }),
    }),

  login: (input: { email: string; password: string }) =>
    apiRequest<LoginResponsePayload>('/auth/login', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify(input),
    }),

  refresh: () =>
    apiRequest<{ refreshed: true; sessionId: string; activeTenantId: string | null }>(
      '/auth/refresh',
      {
        method: 'POST',
        includeCredentials: true,
        body: JSON.stringify({}),
      },
    ),

  logout: () =>
    apiRequest<{ loggedOut: true }>('/auth/logout', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({}),
    }),

  logoutAll: () =>
    apiRequest<{ loggedOutAll: true; revokedCount: number }>('/auth/logout-all', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({}),
    }),

  forgotPassword: (email: string) =>
    apiRequest<{ accepted: true; message: string }>('/auth/forgot-password', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({ email }),
    }),

  resetPassword: (input: { token: string; newPassword: string }) =>
    apiRequest<{ passwordReset: true }>('/auth/reset-password', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify(input),
    }),

  getMe: () =>
    apiRequest<AuthMeResponsePayload>('/auth/me', {
      method: 'GET',
      includeCredentials: true,
    }),

  listSessions: () =>
    apiRequest<AuthSessionSummary[]>('/auth/sessions', {
      method: 'GET',
      includeCredentials: true,
    }),

  revokeSession: (sessionId: string) =>
    apiRequest<{ revoked: true }>(`/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      includeCredentials: true,
    }),

  selectOrganization: (targetOrganizationId: string) =>
    apiRequest<SelectOrganizationResponsePayload>('/auth/select-organization', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({ targetOrganizationId }),
    }),

  exitOrganization: () =>
    apiRequest<SelectOrganizationResponsePayload>('/auth/exit-organization', {
      method: 'POST',
      includeCredentials: true,
      body: JSON.stringify({}),
    }),

  getWorkspaceContext: () =>
    apiRequest<WorkspaceBoundaryContextPayload>('/workspace/context', {
      method: 'GET',
      includeCredentials: true,
    }),

  getTenantAuthLogs: (limit = 25) =>
    apiRequest<AuthAuditLogEntry[]>(`/workspace/admin/auth-logs?limit=${limit}`, {
      method: 'GET',
      includeCredentials: true,
    }),

  getPlatformOverview: () =>
    apiRequest<PlatformAuthOverviewPayload>('/platform/auth/overview', {
      method: 'GET',
      includeCredentials: true,
    }),

  getPlatformAuthLogs: (limit = 25) =>
    apiRequest<AuthAuditLogEntry[]>(`/platform/audit/auth-logs?limit=${limit}`, {
      method: 'GET',
      includeCredentials: true,
    }),

  getDevOutboxPreview: (email: string, kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET') =>
    apiRequest<DevOutboxPreviewDto | null>(
      `/auth/dev-outbox?email=${encodeURIComponent(email)}&kind=${kind}`,
      {
        method: 'GET',
      },
    ),
};
