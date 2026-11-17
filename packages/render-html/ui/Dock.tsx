/**
 * The bottom-right corner of the page: "Back to top" once the page has scrolled past one screen,
 * on every tab, and on the Review tab the step bar next to it (on a phone, above it).
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { UpIcon } from './Icons.tsx';

export function Dock({ children }: { children?: ComponentChildren }) {
  return (
    <div class="dock">
      <BackToTop />
      {children}
    </div>
  );
}

function BackToTop() {
  const far = () => window.scrollY > window.innerHeight;
  const [shown, setShown] = useState(far);
  useEffect(() => {
    const onScroll = () => setShown(far());
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!shown) return null;
  return (
    <button
      class="to-top"
      aria-label="Back to top"
      title="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <UpIcon />
    </button>
  );
}
