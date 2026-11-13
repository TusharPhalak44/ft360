'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import type { ProductBrandingConfig, SystemHealthStatus } from '@ft360/shared-types';
import { ApiClientError, foundationApi } from '@/lib/api/client';

interface DashboardState {
  loading: boolean;
  branding: ProductBrandingConfig | null;
  health: SystemHealthStatus | null;
  correlationId: string | null;
  error: { message: string; code: string; correlationId: string } | null;
}

export function SystemStatusPanel() {
  const [state, setState] = useState<DashboardState>({
    loading: true,
    branding: null,
    health: null,
    correlationId: null,
    error: null,
  });

  const loadFoundationTelemetry = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [brandingRes, healthRes] = await Promise.all([
        foundationApi.getBranding(),
        foundationApi.getSystemHealth(),
      ]);

      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--brand-primary', brandingRes.data.primaryColorHex);
        document.documentElement.style.setProperty('--brand-accent', brandingRes.data.accentColorHex);
        document.title = `${brandingRes.data.productName} – Foundation Status`;
      }

      setState({
        loading: false,
        branding: brandingRes.data,
        health: healthRes.data,
        correlationId: healthRes.correlationId,
        error: null,
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setState({
          loading: false,
          branding: null,
          health: null,
          correlationId: err.correlationId,
          error: {
            message: err.message,
            code: err.code,
            correlationId: err.correlationId,
          },
        });
      } else {
        setState({
          loading: false,
          branding: null,
          health: null,
          correlationId: null,
          error: {
            message: err instanceof Error ? err.message : 'Unable to reach backend API.',
            code: 'NETWORK_ERROR',
            correlationId: 'unavailable',
          },
        });
      }
    }
  }, []);

  useEffect(() => {
    void loadFoundationTelemetry();
  }, [loadFoundationTelemetry]);

  if (state.loading) {
    return (
      <div
        data-testid="loading-state"
        className="mx-auto max-w-5xl p-8 space-y-4 animate-pulse"
        aria-busy="true"
      >
        <div className="h-10 w-72 rounded bg-slate-200" />
        <div className="h-5 w-96 rounded bg-slate-200" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
          <div className="h-36 rounded-xl bg-slate-200" />
          <div className="h-36 rounded-xl bg-slate-200" />
          <div className="h-36 rounded-xl bg-slate-200" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <div
          data-testid="error-state"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm"
        >
          <h2 className="text-lg font-semibold text-red-900">Backend Connectivity Error</h2>
          <p className="mt-1 text-sm text-red-800">{state.error.message}</p>
          <p className="mt-2 font-mono text-xs text-red-700">
            Code: {state.error.code} | Correlation ID: {state.error.correlationId}
          </p>
          <button
            type="button"
            onClick={() => void loadFoundationTelemetry()}
            className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const { branding, health, correlationId } = state;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 space-y-8">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-brand-primary ring-1 ring-inset ring-blue-600/20">
            Phase 1 Foundation Verified ({branding?.source})
          </span>
          <h1 data-testid="product-name" className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
            {branding?.productName}
          </h1>
          <p data-testid="product-tagline" className="mt-1 text-sm text-slate-600">
            {branding?.tagline}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            data-testid="overall-health-badge"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3.5 py-2 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-600/20"
          >
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            API: {health?.status.toUpperCase()}
          </span>
          <button
            type="button"
            onClick={() => void loadFoundationTelemetry()}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Refresh
          </button>
          <Link
            href="/login"
            data-testid="nav-sign-in"
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            data-testid="nav-register"
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Create Account
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            PostgreSQL 18 Native Pool
          </h2>
          <p data-testid="db-role" className="mt-2 text-xl font-bold text-slate-900">
            Role: {health?.database.currentRole}
          </p>
          <dl className="mt-4 space-y-1.5 text-xs text-slate-600">
            <div className="flex justify-between">
              <dt>Engine Version:</dt>
              <dd className="font-mono">{health?.database.serverVersion}</dd>
            </div>
            <div className="flex justify-between">
              <dt>BYPASSRLS / Superuser:</dt>
              <dd data-testid="db-rls-posture" className="font-mono font-semibold text-emerald-700">
                {String(health?.database.bypassRls)} / {String(health?.database.isSuperuser)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Applied SQL Migrations:</dt>
              <dd data-testid="db-migrations-count" className="font-mono">
                {health?.database.appliedMigrations}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Pool (Total / Idle / Waiting):</dt>
              <dd className="font-mono">
                {health?.database.pool.totalCount} / {health?.database.pool.idleCount} /{' '}
                {health?.database.pool.waitingCount}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Redis Cache &amp; BullMQ Broker
          </h2>
          <p data-testid="redis-status" className="mt-2 text-xl font-bold text-slate-900">
            {health?.redis.connected ? 'Connected (PONG)' : 'Disconnected'}
          </p>
          <dl className="mt-4 space-y-1.5 text-xs text-slate-600">
            <div className="flex justify-between">
              <dt>Mode:</dt>
              <dd className="font-mono">{health?.redis.mode}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Ping Latency:</dt>
              <dd className="font-mono">{health?.redis.latencyMs} ms</dd>
            </div>
            <div className="flex justify-between">
              <dt>Key Isolation Prefix:</dt>
              <dd className="font-mono">t:&#123;tenantId&#125;:*</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Configurable Product Identity
          </h2>
          <p className="mt-2 text-xl font-bold text-slate-900">{branding?.primaryColorHex}</p>
          <dl className="mt-4 space-y-1.5 text-xs text-slate-600">
            <div className="flex justify-between">
              <dt>Support Contact:</dt>
              <dd className="font-mono">{branding?.supportEmail}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Environment:</dt>
              <dd className="font-mono">{health?.environment}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Correlation ID:</dt>
              <dd className="font-mono truncate max-w-[160px]" title={correlationId ?? ''}>
                {correlationId}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </main>
  );
}

