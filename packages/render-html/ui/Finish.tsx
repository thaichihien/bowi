/**
 * What "Finish review" opens (UI-24): paper fireworks and a "Review complete" dialog when every
 * step is reviewed, or the steps still to review when some are not. Shown every time Finish is
 * clicked, never on its own. With reduced motion, no fireworks or animation (styles.css).
 */

import { requestWords } from '@bowi/core/review';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowIcon, CloseIcon, StepIconBadge } from './Icons.tsx';
import { Inline } from './Inline.tsx';
import { formatCount, type FlatStep, type Model } from './model.ts';

export type FinishResult = 'complete' | 'incomplete';

const UNREVIEWED_SHOWN = 6;

export function FinishDialog(props: {
  model: Model;
  result: FinishResult;
  flat: FlatStep[];
  reviewed: Set<string>;
  close: () => void;
  go: (groupIndex: number, stepId?: string) => void;
  openChanges: () => void;
}) {
  const { model, flat } = props;
  const plan = model.plan;
  const primary = useRef<HTMLButtonElement>(null);
  const complete = props.result === 'complete';
  const left = flat.filter((f) => !props.reviewed.has(f.step.id));

  // Focus moves into the dialog and back to where it was; Escape closes it.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    primary.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, []);

  const goTo = (f: FlatStep) => {
    props.close();
    props.go(f.groupIndex, f.step.id);
  };
  const words = requestWords(plan.source);
  const what = words ? `${words.request} ${words.ref}` : plan.source.headRef;

  return (
    <>
      {complete && <Fireworks />}
      <div
        class="backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.close();
        }}
      >
        <div
          class={complete ? 'dialog done' : 'dialog'}
          role="dialog"
          aria-modal="true"
          aria-labelledby="finish-title"
        >
          <button class="dialog-x" aria-label="Close" onClick={props.close}>
            <CloseIcon />
          </button>
          {complete ? (
            <>
              <div class="done-badge" aria-hidden="true">
                <span class="done-badge-ring" />
                <span class="done-badge-disc">
                  <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <path
                      class="done-badge-tick"
                      d="M10 18.5l5.5 5.5L26 13"
                      stroke="var(--on-fill)"
                      stroke-width="3.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
              </div>
              <h2 id="finish-title">Review complete</h2>
              <p class="dialog-text">
                You went through all {flat.length} step{flat.length === 1 ? '' : 's'} of {what},
                foundations first.
              </p>
              <div class="dialog-stats">
                <Stat
                  n={plan.groups.length}
                  label={plan.groups.length === 1 ? 'group' : 'groups'}
                />
                <Stat n={plan.stats.files} label={plan.stats.files === 1 ? 'file' : 'files'} />
                <Stat n={plan.stats.reviewLines} label="lines read carefully" />
              </div>
              <div class="dialog-actions center">
                <button
                  class="btn"
                  onClick={() => {
                    props.close();
                    props.openChanges();
                  }}
                >
                  See all changes
                </button>
                <button class="btn primary" ref={primary} onClick={props.close}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <div class="dialog-warn" aria-hidden="true">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v6M12 16.5v.5" />
                </svg>
              </div>
              <h2 id="finish-title">
                {left.length} step{left.length === 1 ? '' : 's'} not reviewed yet
              </h2>
              <p class="dialog-text">
                {left.length <= 2 ? 'Almost there. ' : ''}Review {left.length === 1 ? 'it' : 'them'}{' '}
                to complete the review:
              </p>
              <div class="dialog-list">
                {left.slice(0, UNREVIEWED_SHOWN).map((f) => {
                  const g = plan.groups[f.groupIndex]!;
                  const n = model.stepsOf(g, 'dependency').findIndex((s) => s.id === f.step.id);
                  return (
                    <button key={f.step.id} class="dialog-go" onClick={() => goTo(f)}>
                      <StepIconBadge kind={model.stepIcon(g, f.step)} />
                      <span class="dialog-go-text">
                        <span class="strong">
                          {n >= 0 ? `${n + 1}. ` : ''}
                          <Inline text={f.step.title} />
                        </span>
                        <span class="muted small">
                          <Inline text={g.title} />
                        </span>
                      </span>
                      <ArrowIcon dir="right" />
                    </button>
                  );
                })}
                {left.length > UNREVIEWED_SHOWN && (
                  <span class="muted small">and {left.length - UNREVIEWED_SHOWN} more</span>
                )}
              </div>
              <div class="dialog-actions">
                <button class="btn" onClick={props.close}>
                  Not now
                </button>
                <button class="btn primary" ref={primary} onClick={() => goTo(left[0]!)}>
                  Go to <Inline text={left[0]!.step.title} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div class="dialog-stat">
      <b>{formatCount(n)}</b>
      <span>{label}</span>
    </div>
  );
}

const COLORS = ['#5b44ec', '#2f9e57', '#e0a100', '#d24545', '#8a4fd8', '#13a3a3', '#f08a3c'];

/** Where each burst starts (percent of the window), when, and which way it throws. */
const BURSTS = [
  { x: 12, y: 92, delay: 0, from: -80, to: -30, pieces: 34 }, // popper, bottom left
  { x: 88, y: 92, delay: 0.12, from: -150, to: -100, pieces: 34 }, // popper, bottom right
  { x: 50, y: 34, delay: 0.45, from: 0, to: 360, pieces: 40 }, // firework in the middle
  { x: 26, y: 26, delay: 0.85, from: 0, to: 360, pieces: 24 },
  { x: 74, y: 30, delay: 1.1, from: 0, to: 360, pieces: 24 },
];

export interface Piece {
  left: string;
  top: string;
  style: Record<string, string>;
  shape: 'rect' | 'strip' | 'dot';
}

/**
 * Paper pieces thrown out from each burst point, then fluttering down. Seeded, so the effect is
 * the same every time and tests are stable.
 */
export function fireworkPieces(): Piece[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pieces: Piece[] = [];
  for (const b of BURSTS) {
    for (let i = 0; i < b.pieces; i++) {
      const angle = ((b.from + (b.to - b.from) * ((i + rand()) / b.pieces)) * Math.PI) / 180;
      const popper = b.to - b.from < 360;
      const reach = (popper ? 260 : 120) + rand() * (popper ? 320 : 200);
      const px = Math.cos(angle) * reach;
      const py = Math.sin(angle) * reach;
      const fall = 260 + rand() * 340;
      const r = rand();
      const shape: Piece['shape'] = r < 0.55 ? 'rect' : r < 0.85 ? 'strip' : 'dot';
      pieces.push({
        left: `${b.x}%`,
        top: `${b.y}%`,
        shape,
        style: {
          '--px': `${px.toFixed(0)}px`,
          '--py': `${py.toFixed(0)}px`,
          '--ex': `${(px * 1.25 + (rand() - 0.5) * 120).toFixed(0)}px`,
          '--ey': `${(py + fall).toFixed(0)}px`,
          '--ax': (rand() * 2 - 1).toFixed(2),
          '--r1': `${(200 + rand() * 300).toFixed(0)}deg`,
          '--r2': `${(700 + rand() * 900).toFixed(0)}deg`,
          background: COLORS[(i + pieces.length) % COLORS.length]!,
          animationDelay: `${(b.delay + rand() * 0.08).toFixed(2)}s`,
          animationDuration: `${(2.1 + rand() * 1.1).toFixed(2)}s`,
        },
      });
    }
  }
  return pieces;
}

const PIECES = fireworkPieces();
/** Longest delay + duration, after which the pieces are removed. */
const FIREWORKS_MS = 4600;

function Fireworks() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), FIREWORKS_MS);
    return () => clearTimeout(t);
  }, []);
  if (!on) return null;
  return (
    <div class="fireworks" aria-hidden="true">
      {PIECES.map((p, i) => (
        <span key={i} class={`paper ${p.shape}`} style={{ left: p.left, top: p.top, ...p.style }} />
      ))}
    </div>
  );
}
