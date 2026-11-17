/** Inline stroke icons (16px grid, `currentColor`). Decorative unless given a label. */

import type { ComponentChildren } from 'preact';
import type { StepIcon } from './model.ts';

function Svg({
  children,
  size = 16,
  label,
  class: cls,
}: {
  children: ComponentChildren;
  size?: number;
  label?: string;
  class?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
    >
      {children}
    </svg>
  );
}

const STEP_PATHS: Record<StepIcon, ComponentChildren> = {
  data: (
    <>
      <ellipse cx="8" cy="3.75" rx="5" ry="2" />
      <path d="M3 3.75v8.5c0 1.1 2.24 2 5 2s5-.9 5-2v-8.5M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </>
  ),
  util: (
    <path d="M10.1 2.1a3.25 3.25 0 00-3.9 4.3L2.2 10.4a1.4 1.4 0 002 2l4-4a3.25 3.25 0 004.3-3.9l-2 2-1.7-.4-.4-1.7z" />
  ),
  domain: (
    <>
      <path d="M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z" />
      <path d="M2.5 4.75L8 7.75l5.5-3M8 7.75v6.5" />
    </>
  ),
  service: (
    <>
      <path d="M8 1.75L14.5 5 8 8.25 1.5 5z" />
      <path d="M1.5 8L8 11.25 14.5 8M1.5 11L8 14.25 14.5 11" />
    </>
  ),
  api: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.8 1.7 2.6 3.8 2.6 6.25S9.8 12.55 8 14.25C6.2 12.55 5.4 10.45 5.4 8S6.2 3.45 8 1.75z" />
    </>
  ),
  ui: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M1.75 5.75h12.5M5.75 5.75v7.5" />
    </>
  ),
  config: <path d="M2 4h7M12 4h2M2 12h2M7 12h7M2 8h3M8 8h6M10.5 2.5v3M5.5 10.5v3M6.5 6.5v3" />,
  test: (
    <path d="M5.5 1.75h5M6.5 1.75v4.5L2.6 12.6a1.2 1.2 0 001 1.65h8.8a1.2 1.2 0 001-1.65L9.5 6.25v-4.5M4.4 9.75h7.2" />
  ),
  docs: (
    <>
      <path d="M3 2.5c1.7-.6 3.5-.4 5 .8 1.5-1.2 3.3-1.4 5-.8v10.25c-1.7-.6-3.5-.4-5 .8-1.5-1.2-3.3-1.4-5-.8z" />
      <path d="M8 3.3v10.25" />
    </>
  ),
  file: (
    <>
      <path d="M9.5 1.75H4.25a1 1 0 00-1 1v10.5a1 1 0 001 1h7.5a1 1 0 001-1v-8z" />
      <path d="M9.5 1.75v3.5h3.25" />
    </>
  ),
  move: <path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3" />,
  generated: (
    <>
      <path d="M2 4.75L8 1.75l6 3v6.5l-6 3-6-3z" />
      <path d="M2 4.75l6 3 6-3M8 7.75v6.5" />
    </>
  ),
  format: <path d="M2 3h12M5.5 6.33H14M5.5 9.67H14M2 13h12" />,
};

/** The step's icon in a tinted square (UI-3). */
export function StepIconBadge({ kind }: { kind: StepIcon }) {
  return (
    <span class={`sic ic-${kind}`}>
      <Svg>{STEP_PATHS[kind]}</Svg>
    </span>
  );
}

export function ReviewedIcon({ done }: { done: boolean }) {
  return done ? (
    <svg width="18" height="18" viewBox="0 0 18 18" role="img" aria-label="Reviewed" class="icon">
      <circle cx="9" cy="9" r="8" fill="var(--green)" />
      <path
        d="M5.5 9.2l2.3 2.3 4.6-5"
        fill="none"
        stroke="#fff"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  ) : (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      role="img"
      aria-label="Not reviewed"
      class="icon"
    >
      <circle cx="9" cy="9" r="7.4" fill="none" stroke="#b8b7b1" stroke-width="1.3" />
    </svg>
  );
}

export const Chevron = ({ open }: { open: boolean }) => (
  <Svg size={14} class={open ? 'chev open' : 'chev'}>
    <path d="M6 3.5l4.5 4.5L6 12.5" />
  </Svg>
);

export const MergeIcon = () => (
  <Svg>
    <circle cx="4" cy="3.5" r="1.75" />
    <circle cx="4" cy="12.5" r="1.75" />
    <circle cx="12" cy="8" r="1.75" />
    <path d="M4 5.25v5.5M4 6c0 2 2 2 6.25 2" />
  </Svg>
);

export const BranchIcon = () => (
  <Svg>
    <circle cx="4" cy="3.5" r="1.75" />
    <circle cx="4" cy="12.5" r="1.75" />
    <path d="M4 5.25v5.5" />
  </Svg>
);

export const EyeIcon = () => (
  <Svg>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const CommitIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M1 8h4.25M10.75 8H15" />
  </Svg>
);

export const ReviewTabIcon = () => (
  <Svg>
    <path d="M2 4l1.5 1.5L6 3M2 11l1.5 1.5L6 10M8.5 4.5H14M8.5 11.5H14" />
  </Svg>
);

export const DescriptionIcon = () => (
  <Svg>
    <path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7" />
  </Svg>
);

export const ChangesIcon = () => (
  <Svg>
    <path d="M9.5 1.5H4a1 1 0 00-1 1v11a1 1 0 001 1h8a1 1 0 001-1V5z" />
    <path d="M9.5 1.5V5H13M8 6.5v4M6 8.5h4M6 12h4" />
  </Svg>
);

export const CopyIcon = () => (
  <Svg size={15}>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
    <path d="M10.75 5.25V3.75a1.5 1.5 0 00-1.5-1.5h-5a1.5 1.5 0 00-1.5 1.5v5a1.5 1.5 0 001.5 1.5h1.5" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg size={15}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);

export const ArrowIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <Svg size={16}>
    <path d={dir === 'left' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'} />
  </Svg>
);

export const UpIcon = () => (
  <Svg size={16}>
    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg size={16}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const FolderIcon = () => (
  <Svg size={14}>
    <path d="M1.75 3.75a1 1 0 011-1h3.5l1.5 1.75h5.5a1 1 0 011 1v6.75a1 1 0 01-1 1H2.75a1 1 0 01-1-1z" />
  </Svg>
);

const STATUS_LABELS: Record<string, string> = {
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
};

/** GitHub-style square: plus for added, minus for deleted, arrow for renamed, dot otherwise. */
export function FileStatusIcon({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? 'Modified';
  const mark =
    status === 'added' ? (
      <path d="M8 5v6M5 8h6" />
    ) : status === 'deleted' ? (
      <path d="M5 8h6" />
    ) : status === 'renamed' || status === 'copied' ? (
      <path d="M5 8h6M8.5 5.5L11 8l-2.5 2.5" />
    ) : (
      <circle cx="8" cy="8" r="1.75" fill="currentColor" />
    );
  return (
    <span class={`fstat fstat-${STATUS_LABELS[status] ? status : 'modified'}`}>
      <Svg size={14} label={label}>
        <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.5" />
        {mark}
      </Svg>
    </span>
  );
}
