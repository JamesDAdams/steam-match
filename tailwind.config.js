/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Couleurs sémantiques : pointent vers les variables de style.css,
        // donc elles suivent automatiquement le thème clair/sombre.
        app: {
          bg: 'var(--bg)',
          elevated: 'var(--bg-elevated)',
          surface: 'var(--surface)',
          surface2: 'var(--surface-2)',
          surface3: 'var(--surface-3)',
        },
        line: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        fg: {
          DEFAULT: 'var(--text)',
          strong: 'var(--text-strong)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
        },
        brand: {
          DEFAULT: 'var(--brand)',
          strong: 'var(--brand-strong)',
          soft: 'var(--brand-soft)',
        },
        gold: {
          DEFAULT: 'var(--gold)',
          strong: 'var(--gold-strong)',
          soft: 'var(--gold-soft)',
        },
        ok: {
          DEFAULT: 'var(--ok)',
          soft: 'var(--ok-soft)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          soft: 'var(--warn-soft)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          soft: 'var(--danger-soft)',
        },
        discord: 'var(--discord)',

        // Alias historiques : les vues existantes utilisent encore
        // steam-blue / steam-dark / steam-navy. Ils sont mappés sur les
        // variables de thème pour que le mode clair fonctionne sans
        // réécrire chaque composant.
        steam: {
          dark: 'var(--surface)',
          darker: 'var(--bg)',
          navy: 'var(--surface-2)',
          blue: 'var(--brand)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl: '0.9rem',
      },
    },
  },
  plugins: [],
};
