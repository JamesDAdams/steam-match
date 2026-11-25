import { ref } from 'vue';

/**
 * Thème clair / sombre.
 *
 * Le choix est mémorisé dans localStorage ; sans choix explicite, on suit la
 * préférence du système. Le thème est appliqué en posant la classe `light` sur
 * <html>, ce qui bascule les variables CSS (voir style.css).
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'sm-theme';

const theme = ref<Theme>('dark');
let initialized = false;

function systemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function apply(value: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('light', value === 'light');
}

export function useTheme() {
  /** À appeler une fois au démarrage. */
  function init() {
    if (initialized || typeof window === 'undefined') return;
    initialized = true;

    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    theme.value = stored === 'light' || stored === 'dark' ? stored : systemTheme();
    apply(theme.value);

    // Si l'utilisateur n'a jamais choisi, on suit les changements système.
    window
      .matchMedia?.('(prefers-color-scheme: light)')
      .addEventListener?.('change', (e) => {
        if (localStorage.getItem(STORAGE_KEY)) return;
        theme.value = e.matches ? 'light' : 'dark';
        apply(theme.value);
      });
  }

  function set(next: Theme) {
    theme.value = next;
    localStorage.setItem(STORAGE_KEY, next);

    // Petite transition pour éviter un basculement brutal.
    const root = document.documentElement;
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 300);

    apply(next);
  }

  function toggle() {
    set(theme.value === 'dark' ? 'light' : 'dark');
  }

  return { theme, init, set, toggle };
}
