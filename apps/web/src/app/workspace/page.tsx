'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useState } from 'react';
import type {
  AuthMeResponsePayload,
  AuthSessionSummary,
  WorkspaceBoundaryContextPayload,
} from '@ft360/shared-types';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function WorkspacePage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthMeResponsePayload | null>(null);
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceBoundaryContextPayload | null>(null);
  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [meRes, sessRes] = await Promise.all([authApi.getMe(), authApi.listSessions()]);
      setMe(meRes.data);
      setSessions(sessRes.data);

      if (meRes.data.activeOrganization) {
        const wsRes = await authApi.getWorkspaceContext();
        setWorkspaceCtx(wsRes.data);
      } else {
        setWorkspaceCtx(null);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.replace('/login');
        return;
      }
      setError(err instanceof ApiClientError ? err.message : 'Failed to load workspace session.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData]);

  const handleLogout = async () => {
    await authApi.logout().catch(() => null);
    router.replace('/login');
  };

  const handleLogoutAll = async () => {
    await authApi.logoutAll().catch(() => null);
    router.replace('/login');
  };

  const handleRevokeDevice = async (sessionId: string) => {
    try {
      await authApi.revokeSession(sessionId);
      if (me?.sessionId === sessionId) {
        router.replace('/login');
        return;
      }
      await loadWorkspaceData();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to revoke session.');
    }
  };

  return (
    <AuthShell
      wide
      title="Authenticated Identity & Workspace Boundary"
      subtitle="Verified session context, RBAC authorization posture, and active device sessions."
    >
      {loading && <p className="text-sm text-slate-500">Loading authenticated session...</p>}

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
        >
          {error}
        </div>
      )}

      {!loading && me && (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Authenticated User
              </p>
              <h2 data-testid="workspace-user-fullname" className="text-lg font-bold text-slate-900">
                {me.user.fullName}
              </h2>
              <p data-testid="workspace-user-email" className="text-sm text-slate-600">
                {me.user.email}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Link
                href="/select-organization"
                data-testid="switch-org-link"
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Switch Organization
              </Link>
              <button
                type="button"
                data-testid="logout-all-btn"
                onClick={() => void handleLogoutAll()}
                className="rounded-lg border border-red-300 bg-white px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
              >
                Sign Out All Devices
              </button>
              <button
                type="button"
                data-testid="logout-btn"
                onClick={() => void handleLogout()}
                className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Sign Out
              </button>
            </div>
          </section>

          {workspaceCtx ? (
            <section
              data-testid="active-workspace-panel"
              className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-800">
                    Active Verified Organization
                  </span>
                  <h3
                    data-testid="active-org-name"
                    className="text-xl font-bold text-slate-900 mt-0.5"
                  >
                    {workspaceCtx.organization.tenantDisplayName}
                  </h3>
                  <p className="font-mono text-xs text-slate-600">
                    Slug: {workspaceCtx.organization.tenantSlug} | Role Posture:{' '}
                    <span data-testid="workspace-admin-flag">
                      {workspaceCtx.isTenantAdmin ? 'TENANT_ADMIN' : 'STANDARD_MEMBER'}
                    </span>
                  </p>
                </div>

                <Link
                  href="/workspace/admin"
                  data-testid="workspace-admin-link"
                  className="rounded-lg bg-emerald-800 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-900"
                >
                  Tenant Admin Audit Console
                </Link>
              </div>

              <div>
                <p className="text-xs font-medium text-slate-600 mb-1.5">
                  Effective Tenant Permissions ({workspaceCtx.effectivePermissions.length}):
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {workspaceCtx.effectivePermissions.length === 0 ? (
                    <span className="text-xs text-slate-500">No explicit RBAC permissions assigned</span>
                  ) : (
                    workspaceCtx.effectivePermissions.map((code) => (
                      <span
                        key={code}
                        className="rounded-md bg-white border border-slate-200 px-2 py-0.5 font-mono text-xs text-slate-800"
                      >
                        {code}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </section>
          ) : (
            <section
              data-testid="unscoped-workspace-notice"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex items-center justify-between"
            >
              <span>No active organization selected on this session.</span>
              <Link
                href="/select-organization"
                className="rounded-lg bg-amber-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-900"
              >
                Choose Organization
              </Link>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">
              Active Device Sessions ({sessions.length})
            </h3>
            <div className="divide-y divide-slate-200 rounded-xl border border-slate-200">
              {sessions.map((s) => (
                <div key={s.id} className="p-4 flex items-center justify-between gap-4 text-xs">
                  <div className="space-y-0.5">
                    <p className="font-semibold text-slate-900">
                      Session {s.id.slice(0, 8)}{' '}
                      {s.isCurrent && (
                        <span className="ml-1.5 rounded bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
                          Current Device
                        </span>
                      )}
                    </p>
                    <p className="text-slate-500">
                      IP: {s.ipAddress || 'local'} | Expires: {new Date(s.expiresAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRevokeDevice(s.id)}
                    className="rounded-md border border-slate-300 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </AuthShell>
  );
}
