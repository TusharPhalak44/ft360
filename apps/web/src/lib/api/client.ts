import type {
  ApiErrorResponse,
  ApiSuccessResponse,
  ProductBrandingConfig,
  SystemHealthStatus,
} from '@ft360/shared-types';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string;

  constructor(params: { message: string; code: string; status: number; correlationId: string }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.code = params.code;
    this.status = params.status;
    this.correlationId = params.correlationId;
  }
}

function getApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');
}

/**
 * Centralized REST API client for communicating with the authoritative NestJS backend.
 * Note: Never attaches client-spoofed `tenant_id` headers or query parameters;
 * tenant context is resolved strictly by the backend from verified session credentials.
 */
export async function apiRequest<T>(
  endpointPath: string,
  init?: RequestInit,
): Promise<{ data: T; correlationId: string }> {
  const url = `${getApiBaseUrl()}/${endpointPath.replace(/^\/+/, '')}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  const headerCorrelationId = response.headers.get('x-correlation-id') || 'unavailable';
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

