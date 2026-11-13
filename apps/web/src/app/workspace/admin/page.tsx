'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import type { AuthAuditLogEntry } from '@ft360/shared-types';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function WorkspaceAdminBoundaryPage() {
  const router = useRouter();
  const [logs, setLogs] = useState<AuthAuditLogEntry[] | null>(null);
  const [deniedError, setDeniedError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    authApi
      .getTenantAuthLogs(25)
      .then((res) => {
        if (!active) return;
        setLogs(res.data);
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
            message: 'Unable to reach Tenant Admin boundary endpoint.',
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
      title="Tenant Admin Security Audit Console"
      subtitle="Enforced by JwtAuthGuard -> TenantMembershipGuard -> TenantAdminGuard + PostgreSQL FORCE RLS."
    >
      {loading && <p className="text-sm text-slate-500">Verifying Tenant Admin permissions...</p>}

      {deniedError && (
        <div
          data-testid="tenant-admin-denied-banner"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900 space-y-2"
        >
          <p className="font-bold">Tenant Admin Boundary Enforced (403)</p>
          <p>{deniedError.message}</p>
          <p className="font-mono text-xs text-red-700">Code: {deniedError.code}</p>
        </div>
      )}

      {!loading && logs && (
        <div data-testid="tenant-admin-audit-table" className="space-y-4">
          <p className="text-xs text-slate-600">
            Showing {logs.length} tenant-scoped authentication audit events isolated to your active
            organization:
          </p>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-left font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">Event</th>
                  <th className="px-4 py-2.5">Outcome</th>
                  <th className="px-4 py-2.5">IP</th>
                  <th className="px-4 py-2.5">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {logs.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-2 font-mono text-slate-900">{entry.eventType}</td>
                    <td className="px-4 py-2 font-semibold">{entry.outcome}</td>
                    <td className="px-4 py-2 font-mono text-slate-500">
                      {entry.ipAddress || 'local'}
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
      )}

      <div className="mt-6 flex justify-between text-xs">
        <Link href="/workspace" className="font-semibold text-blue-700 hover:underline">
          &larr; Back to Workspace Overview
        </Link>
        <Link href="/select-organization" className="font-semibold text-slate-700 hover:underline">
          Switch Organization
        </Link>
      </div>
    </AuthShell>
  );
}
