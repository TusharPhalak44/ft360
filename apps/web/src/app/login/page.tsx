'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [error, setError] = useState<{
    message: string;
    code: string;
    retryAfterSeconds?: number;
  } | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResendInfo(null);

    try {
      const res = await authApi.login({
        email: email.trim(),
        password,
      });

      const payload = res.data;
      if (payload.organizations.length > 0) {
        router.push('/select-organization');
      } else if (payload.user.isPlatformSuperAdmin) {
        router.push('/platform');
      } else {
        router.push('/workspace');
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({
          message: err.message,
          code: err.code,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      } else {
        setError({
          message: 'Unable to reach authentication service.',
          code: 'NETWORK_ERROR',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email.trim()) return;
    try {
      const res = await authApi.resendVerification(email.trim());
      setResendInfo(res.data.message);
    } catch {
      setResendInfo('Unable to resend verification email right now.');
    }
  };

  return (
    <AuthShell
      title="Sign In"
      subtitle="Authenticate once, then select your verified organization workspace."
    >
      {error && (
        <div
          data-testid="login-error"
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900 space-y-2"
        >
          <p className="font-semibold">{error.message}</p>
          <p className="font-mono text-xs text-red-700">
            Code: {error.code}
            {error.retryAfterSeconds ? ` | Retry-After: ${error.retryAfterSeconds}s` : ''}
          </p>
          {error.code === 'EMAIL_NOT_VERIFIED' && (
            <button
              type="button"
              onClick={() => void handleResendVerification()}
              className="rounded-md bg-red-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-900"
            >
              Resend Verification Link
            </button>
          )}
        </div>
      )}

      {resendInfo && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          {resendInfo}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label htmlFor="login-email" className="block text-sm font-medium text-slate-700">
            Email Address
          </label>
          <input
            id="login-email"
            data-testid="login-email-input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
            placeholder="you@organization.example"
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
              Password
            </label>
            <Link href="/forgot-password" className="text-xs font-medium text-blue-700 hover:underline">
              Forgot password?
            </Link>
          </div>
          <input
            id="login-password"
            data-testid="login-password-input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
            placeholder="Enter your password"
          />
        </div>

        <button
          type="submit"
          data-testid="login-submit-btn"
          disabled={submitting}
          className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? 'Signing In...' : 'Sign In'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-600">
        New to the platform?{' '}
        <Link href="/register" className="font-semibold text-blue-700 hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
