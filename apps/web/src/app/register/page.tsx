'use client';

import Link from 'next/link';
import React, { useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { ApiClientError, authApi } from '@/lib/api/client';

export default function RegisterPage() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code: string; details?: string[] } | null>(
    null,
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authApi.register({
        fullName: fullName.trim(),
        email: email.trim(),
        password,
      });
      setRegisteredEmail(res.data.user.email);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({
          message: err.message,
          code: err.code,
          details: err.details?.map((d) => d.issue),
        });
      } else {
        setError({
          message: 'Unable to complete registration. Please try again.',
          code: 'NETWORK_ERROR',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (registeredEmail) {
    return (
      <AuthShell
        title="Verify Your Email Address"
        subtitle="Your account has been created in pending status."
      >
        <div
          data-testid="register-success-banner"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 space-y-2"
        >
          <p className="font-semibold">Verification email dispatched</p>
          <p>
            We sent a single-use verification link to{' '}
            <span className="font-mono font-semibold">{registeredEmail}</span>. Verify your email
            before signing in.
          </p>
        </div>
        <div className="mt-6 flex items-center justify-between text-sm">
          <Link href="/verify-email" className="font-medium text-blue-700 hover:underline">
            Enter verification token manually
          </Link>
          <Link
            href="/login"
            data-testid="goto-login-after-register"
            className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800"
          >
            Go to Sign In
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create Your Account"
      subtitle="Protected with Argon2id hashing and mandatory email verification."
    >
      {error && (
        <div
          data-testid="register-error"
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
        >
          <p className="font-semibold">{error.message}</p>
          {error.details && error.details.length > 0 && (
            <ul className="mt-1.5 list-disc pl-5 text-xs space-y-0.5">
              {error.details.map((issue, idx) => (
                <li key={idx}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label htmlFor="reg-full-name" className="block text-sm font-medium text-slate-700">
            Full Name
          </label>
          <input
            id="reg-full-name"
            data-testid="register-fullname-input"
            type="text"
            required
            minLength={2}
            maxLength={160}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
            placeholder="Aarav Kulkarni"
          />
        </div>

        <div>
          <label htmlFor="reg-email" className="block text-sm font-medium text-slate-700">
            Work Email
          </label>
          <input
            id="reg-email"
            data-testid="register-email-input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
            placeholder="you@organization.example"
          />
        </div>

        <div>
          <label htmlFor="reg-password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            id="reg-password"
            data-testid="register-password-input"
            type="password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-blue-600 focus:outline-none"
            placeholder="Minimum 12 chars with upper, lower, digit & symbol"
          />
        </div>

        <button
          type="submit"
          data-testid="register-submit-btn"
          disabled={submitting}
          className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? 'Creating Account...' : 'Create Account'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-blue-700 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
