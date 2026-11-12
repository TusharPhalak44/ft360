import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: 'var(--brand-primary, #2563EB)',
          accent: 'var(--brand-accent, #0F172A)',
        },
      },
    },
  },
  plugins: [],
};

export default config;

