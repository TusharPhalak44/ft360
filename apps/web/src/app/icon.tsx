import { ImageResponse } from 'next/og';
import type { ApiSuccessResponse, ProductBrandingConfig } from '@ft360/shared-types';

export const size = {
  width: 32,
  height: 32,
};

export const contentType = 'image/png';

export default async function Icon() {
  let initial = 'F';
  let bgHex = '#2563EB';

  try {
    const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');
    const res = await fetch(`${apiBase}/public/branding`, { cache: 'no-store' });
    if (res.ok) {
      const payload = (await res.json()) as ApiSuccessResponse<ProductBrandingConfig>;
      if (payload.success && payload.data) {
        initial = payload.data.productName.trim().charAt(0).toUpperCase() || 'F';
        bgHex = payload.data.primaryColorHex || '#2563EB';
      }
    }
  } catch {
    // Graceful fallback icon when API is starting up
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: bgHex,
          color: '#FFFFFF',
          borderRadius: '6px',
          fontSize: 20,
          fontWeight: 700,
        }}
      >
        {initial}
      </div>
    ),
    { ...size },
  );
}

