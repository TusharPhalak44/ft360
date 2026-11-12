import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Enterprise Workspace Foundation',
  description: 'Configurable Multi-Tenant SaaS Platform Shell',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
