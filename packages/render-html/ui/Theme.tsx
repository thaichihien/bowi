/**
 * Dark mode (M18, UI-29): the page follows the system's setting, live, until the reviewer picks
 * a theme with the header's button; the pick is kept in this browser and then wins. The theme is
 * the `dark` class on <html>, first set by the script in index.html with the same rule, before the
 * first paint, so the page never flashes light. Design: the report redesign canvas.
 */

import { useEffect, useState } from 'preact/hooks';
import { MoonIcon, SunIcon } from './Icons.tsx';

export const THEME_KEY = 'bowi:theme';
const QUERY = '(prefers-color-scheme: dark)';

type Pick = 'light' | 'dark' | null;

function storedPick(): Pick {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemDark(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function ThemeButton() {
  const [pick, setPick] = useState<Pick>(storedPick);
  const [system, setSystem] = useState(systemDark);
  const dark = pick ? pick === 'dark' : system;

  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const onChange = () => setSystem(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    setPick(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered: kept until the page closes.
    }
  };
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button class="btn small theme-btn" aria-label={label} title={label} onClick={toggle}>
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
