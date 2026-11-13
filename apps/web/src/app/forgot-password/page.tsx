'use client';

import Link from 'next/link';
import React, { useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authApi.forgotPassword(email.trim());
      setSubmittedMessage(res.data.message);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Unable to submit password recovery request.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Password Recovery"
      subtitle="Enter your email address to receive a single-use password reset link."
    >
      {submittedMessage ? (
        <div className="space-y-4">
          <div
            data-testid="forgot-password-accepted"
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            {submittedMessage}
          </div>
          <Link
            href="/login"
            className="block w-full text-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Back to Sign In
          </Link>
        </div>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
            >
              {error}
            </div>
          )}

          <div>
            <label htmlFor="forgot-email" className="block text-sm font-medium text-slate-700">
              Email Address
            </label>
            <input
              id="forgot-email"
              data-testid="forgot-email-input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
              placeholder="you@organization.example"
            />
          </div>

          <button
            type="submit"
            data-testid="forgot-submit-btn"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Send Reset Instructions'}
          </button>

          <p className="text-center text-sm text-slate-600">
            <Link href="/login" className="font-medium text-blue-700 hover:underline">
              Return to Sign In
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
