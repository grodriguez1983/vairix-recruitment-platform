'use client';

/**
 * Client-side theme toggle. Reads the current state from the
 * `data-theme` attribute on <html> (set by ThemeBootScript before
 * hydration), updates it on click, and persists the choice.
 */
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

export function ThemeToggle(): JSX.Element {
  // `mounted` avoids hydration mismatch: server renders the default
  // (dark) icon; after hydration we sync with the real DOM state.
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  function toggle(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // localStorage disabled — the attribute change still applies
      // for the current session.
    }
    setTheme(next);
  }

  const Icon = mounted && theme === 'light' ? Sun : Moon;
  const label = mounted && theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';

  return (
    <button
      type="button"
      aria-label={label}
      onClick={toggle}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-text-muted hover:text-text-primary transition-colors"
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
