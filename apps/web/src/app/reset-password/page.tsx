'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import React, { Suspense, useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const [token, setToken] = useState(searchParams.get('token') ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await authApi.resetPassword({
        token: token.trim(),
        newPassword,
      });
      setCompleted(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Unable to reset password. Token may be invalid or expired.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (completed) {
    return (
      <div className="space-y-4">
        <div
          data-testid="reset-password-success"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          Password updated and all prior active sessions have been revoked. Please sign in with your
          new password.
        </div>
        <Link
          href="/login"
          data-testid="goto-login-after-reset"
          className="block w-full text-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Sign In with New Password
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error && (
        <div
          data-testid="reset-password-error"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
        >
          {error}
        </div>
      )}

      <div>
        <label htmlFor="reset-token" className="block text-sm font-medium text-slate-700">
          Reset Token
        </label>
        <input
          id="reset-token"
          data-testid="reset-token-input"
          type="text"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-mono focus:border-blue-600 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="reset-new-password" className="block text-sm font-medium text-slate-700">
          New Password
        </label>
        <input
          id="reset-new-password"
          data-testid="reset-new-password-input"
          type="password"
          required
          minLength={12}
          maxLength={128}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
          placeholder="Minimum 12 chars with upper, lower, digit & symbol"
        />
      </div>

      <button
        type="submit"
        data-testid="reset-submit-btn"
        disabled={submitting}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {submitting ? 'Updating Password...' : 'Update Password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Set New Password"
      subtitle="Resetting your password immediately revokes all existing sessions."
    >
      <Suspense fallback={<div className="text-sm text-slate-500">Loading reset form...</div>}>
        <ResetPasswordInner />
      </Suspense>
    </AuthShell>
  );
}
