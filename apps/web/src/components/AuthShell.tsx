'use client';

import Link from 'next/link';
import React, { useEffect, useState, type ReactNode } from 'react';
import type { ProductBrandingConfig } from '@ft360/shared-types';
import { foundationApi } from '@/lib/api/client';

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  wide?: boolean;
}

export function AuthShell({ title, subtitle, children, wide = false }: AuthShellProps) {
  const [branding, setBranding] = useState<ProductBrandingConfig | null>(null);

  useEffect(() => {
    let active = true;
    foundationApi
      .getBranding()
      .then((res) => {
        if (!active) return;
        setBranding(res.data);
        if (typeof document !== 'undefined') {
          document.documentElement.style.setProperty('--brand-primary', res.data.primaryColorHex);
          document.documentElement.style.setProperty('--brand-accent', res.data.accentColorHex);
          document.title = `${res.data.productName} – ${title}`;
        }
      })
      .catch(() => {
        // Fallback gracefully if branding fetch fails
      });
    return () => {
      active = false;
    };
  }, [title]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 text-slate-900 font-bold text-lg">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: branding?.primaryColorHex || '#2563EB' }}
            />
            <span data-testid="auth-brand-name">{branding?.productName || 'Enterprise Suite'}</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium text-slate-600">
            <Link href="/" className="hover:text-slate-900">
              System Status
            </Link>
            <Link href="/login" className="hover:text-slate-900">
              Sign In
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-white hover:bg-slate-800"
            >
              Register
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div
          className={`w-full ${wide ? 'max-w-4xl' : 'max-w-md'} rounded-2xl border border-slate-200 bg-white p-8 shadow-sm`}
        >
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
