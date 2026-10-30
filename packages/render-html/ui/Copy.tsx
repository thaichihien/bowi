/** Icon button that copies text to the clipboard and briefly shows a check mark. */

import { useEffect, useState } from 'preact/hooks';
import { CheckIcon, CopyIcon } from './Icons.tsx';

export function CopyButton({
  text,
  label,
  class: cls,
}: {
  text: string;
  label: string;
  class?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      class={cls ?? 'icon-btn'}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // No clipboard access (e.g. an old browser on file://): nothing to show.
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
