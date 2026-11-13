'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import React, { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

function VerifyEmailInner() {
  const searchParams = useSearchParams();
  const urlToken = searchParams.get('token') ?? '';
  const [token, setToken] = useState(urlToken);
  const [status, setStatus] = useState<'idle' | 'verifying' | 'verified' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const executeVerification = useCallback(async (rawToken: string) => {
    if (!rawToken.trim()) return;
    setStatus('verifying');
    setErrorMsg(null);
    try {
      await authApi.verifyEmail(rawToken.trim());
      setStatus('verified');
    } catch (err) {
      setStatus('error');
      setErrorMsg(
        err instanceof ApiClientError
          ? err.message
          : 'Unable to verify email token. Please request a fresh verification link.',
      );
    }
  }, []);

  useEffect(() => {
    if (urlToken) {
      setToken(urlToken);
      void executeVerification(urlToken);
    }
  }, [urlToken, executeVerification]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void executeVerification(token);
  };

  if (status === 'verified') {
    return (
      <div className="space-y-5">
        <div
          data-testid="email-verified-banner"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          <p className="font-semibold">Email address verified</p>
          <p className="mt-1">Your account is now active. You can proceed to sign in.</p>
        </div>
        <Link
          href="/login"
          data-testid="goto-login-after-verify"
          className="block w-full text-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Continue to Sign In
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {errorMsg && (
        <div
          data-testid="verify-email-error"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
        >
          {errorMsg}
        </div>
      )}

      <div>
        <label htmlFor="verify-token" className="block text-sm font-medium text-slate-700">
          Verification Token
        </label>
        <input
          id="verify-token"
          data-testid="verify-token-input"
          type="text"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-mono focus:border-blue-600 focus:outline-none"
          placeholder="Paste verification token"
        />
      </div>

      <button
        type="submit"
        data-testid="verify-submit-btn"
        disabled={status === 'verifying'}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {status === 'verifying' ? 'Verifying...' : 'Verify Email'}
      </button>
    </form>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthShell
      title="Email Verification"
      subtitle="Confirm your email ownership to activate workspace sign-in."
    >
      <Suspense fallback={<div className="text-sm text-slate-500">Loading verification state...</div>}>
        <VerifyEmailInner />
      </Suspense>
    </AuthShell>
  );
}
