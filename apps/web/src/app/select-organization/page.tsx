'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useState } from 'react';
import type { AuthMeResponsePayload } from '@ft360/shared-types';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function SelectOrganizationPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthMeResponsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadIdentity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authApi.getMe();
      setMe(res.data);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        router.replace('/login');
        return;
      }
      setError(err instanceof ApiClientError ? err.message : 'Failed to load workspaces.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  const handleSelectOrg = async (tenantId: string) => {
    setSelectingId(tenantId);
    setError(null);
    try {
      await authApi.selectOrganization(tenantId);
      router.push('/workspace');
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Organization selection failed.',
      );
    } finally {
      setSelectingId(null);
    }
  };

  const handleEnterPlatformPlane = async () => {
    setError(null);
    try {
      await authApi.exitOrganization();
      router.push('/platform');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to switch plane.');
    }
  };

  const handleLogout = async () => {
    await authApi.logout().catch(() => null);
    router.replace('/login');
  };

  return (
    <AuthShell
      wide
      title="Select Organization Workspace"
      subtitle="Organization context is verified server-side against active memberships before activation."
    >
      {loading && <p className="text-sm text-slate-500">Loading verified organizations...</p>}

      {error && (
        <div
          data-testid="select-org-error"
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
        >
          {error}
        </div>
      )}

      {!loading && me && (
        <div className="space-y-6">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm">
            <div>
              <span className="text-slate-500">Signed in as: </span>
              <span data-testid="org-picker-user-email" className="font-semibold text-slate-900">
                {me.user.email}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="text-xs font-semibold text-red-700 hover:underline"
            >
              Sign Out
            </button>
          </div>

          {me.organizations.length === 0 ? (
            <div
              data-testid="no-organizations-banner"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            >
              Your account does not currently belong to an active tenant organization. Contact an
              organization administrator for an invitation.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {me.organizations.map((org) => (
                <div
                  key={org.tenantId}
                  data-testid={`org-card-${org.tenantSlug}`}
                  className="rounded-xl border border-slate-200 p-5 flex flex-col justify-between gap-4 hover:border-slate-400 transition"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-base font-bold text-slate-900">
                        {org.tenantDisplayName}
                      </h2>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                        {org.tenantStatus}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-xs text-slate-500">Slug: {org.tenantSlug}</p>
                    <p className="mt-2 text-xs text-slate-600">
                      Membership: <span className="font-semibold">{org.membershipType}</span> (
                      {org.membershipStatus})
                    </p>
                  </div>

                  <button
                    type="button"
                    data-testid={`select-org-btn-${org.tenantSlug}`}
                    disabled={selectingId === org.tenantId}
                    onClick={() => void handleSelectOrg(org.tenantId)}
                    className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                  >
                    {selectingId === org.tenantId ? 'Activating Workspace...' : 'Enter Workspace'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {me.user.isPlatformSuperAdmin && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-indigo-950">
                  Platform Super Admin Control Plane
                </h3>
                <p className="text-xs text-indigo-800">
                  Operate in unscoped platform governance plane without entering a tenant workspace.
                </p>
              </div>
              <button
                type="button"
                data-testid="enter-platform-plane-btn"
                onClick={() => void handleEnterPlatformPlane()}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-800"
              >
                Open Platform Console
              </button>
            </div>
          )}

          <div className="pt-2 text-xs text-slate-500 flex justify-between">
            <span>Active Session ID: {me.sessionId.slice(0, 8)}...</span>
            <Link href="/workspace" className="text-blue-700 hover:underline">
              View Session &amp; Security Settings
            </Link>
          </div>
        </div>
      )}
    </AuthShell>
  );
}
