'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import type { AuthAuditLogEntry, PlatformAuthOverviewPayload } from '@ft360/shared-types';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function PlatformControlPlanePage() {
  const router = useRouter();
  const [overview, setOverview] = useState<PlatformAuthOverviewPayload | null>(null);
  const [logs, setLogs] = useState<AuthAuditLogEntry[]>([]);
  const [deniedError, setDeniedError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([authApi.getPlatformOverview(), authApi.getPlatformAuthLogs(20)])
      .then(([ovRes, logsRes]) => {
        if (!active) return;
        setOverview(ovRes.data);
        setLogs(logsRes.data);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiClientError) {
          if (err.status === 401) {
            router.replace('/login');
            return;
          }
          setDeniedError({ code: err.code, message: err.message });
        } else {
          setDeniedError({
            code: 'NETWORK_ERROR',
            message: 'Unable to reach Platform Super Admin boundary.',
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <AuthShell
      wide
      title="Platform Super Admin Control Plane"
      subtitle="Enforced by PlatformSuperAdminGuard (`is_platform_super_admin = TRUE` & unscoped session)."
    >
      {loading && <p className="text-sm text-slate-500">Verifying Platform Super Admin boundary...</p>}

      {deniedError && (
        <div
          data-testid="platform-denied-banner"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900 space-y-2"
        >
          <p className="font-bold">Platform Control Plane Access Denied (403)</p>
          <p>{deniedError.message}</p>
          <p className="font-mono text-xs text-red-700">Code: {deniedError.code}</p>
        </div>
      )}

      {!loading && overview && (
        <div data-testid="platform-overview-panel" className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="rounded-xl border border-slate-200 p-3.5">
              <p className="text-[11px] font-semibold uppercase text-slate-500">Total Users</p>
              <p className="mt-1 text-xl font-bold text-slate-900">{overview.metrics.totalUsers}</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3.5">
              <p className="text-[11px] font-semibold uppercase text-slate-500">Active Users</p>
              <p className="mt-1 text-xl font-bold text-emerald-700">
                {overview.metrics.activeUsers}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3.5">
              <p className="text-[11px] font-semibold uppercase text-slate-500">Pending Verify</p>
              <p className="mt-1 text-xl font-bold text-amber-700">
                {overview.metrics.pendingUsers}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3.5">
              <p className="text-[11px] font-semibold uppercase text-slate-500">Active Tenants</p>
              <p className="mt-1 text-xl font-bold text-slate-900">
                {overview.metrics.activeTenants}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3.5">
              <p className="text-[11px] font-semibold uppercase text-slate-500">Live Sessions</p>
              <p className="mt-1 text-xl font-bold text-blue-700">
                {overview.metrics.activeSessions}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold text-slate-900">
              Global Platform Authentication Audit Ledger ({logs.length})
            </h3>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5">Event</th>
                    <th className="px-4 py-2.5">Outcome</th>
                    <th className="px-4 py-2.5">Plane</th>
                    <th className="px-4 py-2.5">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {logs.map((entry) => (
                    <tr key={entry.id}>
                      <td className="px-4 py-2 font-mono text-slate-900">{entry.eventType}</td>
                      <td className="px-4 py-2 font-semibold">{entry.outcome}</td>
                      <td className="px-4 py-2 font-mono text-slate-500">
                        {entry.tenantId ? `TENANT:${entry.tenantId.slice(0, 8)}` : 'GLOBAL'}
                      </td>
                      <td className="px-4 py-2 text-slate-500">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 flex justify-between text-xs">
        <Link href="/select-organization" className="font-semibold text-blue-700 hover:underline">
          &larr; Back to Organization Picker
        </Link>
        <Link href="/" className="font-semibold text-slate-700 hover:underline">
          System Health Dashboard
        </Link>
      </div>
    </AuthShell>
  );
}
