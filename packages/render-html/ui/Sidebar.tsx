/**
 * The Review tab's left column (UI-3): two views behind tabs, remembered in this browser.
 *
 * - Steps: groups and their steps with a quick "reviewed" mark per step. The current step's row
 *   shows where its files live instead of its subtitle: clicking it shows or hides a folder tree
 *   of the step's files (shown by default, remembered), and a file jumps to its card.
 * - Files: the whole pull request as a folder tree, as in the Changes tab. The current step's
 *   files are highlighted and the rest dimmed, each file ends with the number of its step(s),
 *   and folders without a file of the step start folded. Above it, the current step and a strip
 *   with one pill per step. Pills, and files of other steps, go to their step.
 *
 * Step colours follow the step icons (data teal, services blue, API purple, …). The design is
 * the report redesign canvas linked in docs/plan.md.
 */

import type { FileChange, Group, Step } from '@bowi/core/types';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { buildTree, type Dir } from './Changes.tsx';
import { Chevron, FileStatusIcon, FolderIcon, ReviewedIcon, StepIconBadge } from './Icons.tsx';
import { Inline } from './Inline.tsx';
import {
  baseName,
  githubOrder,
  KIND_LABELS,
  type FlatStep,
  type Model,
  type ReadingMode,
  type StepIcon,
} from './model.ts';
import type { Position } from './Review.tsx';

const VIEW_KEY = 'bowi:review-left';
const TREE_KEY = 'bowi:review-step-tree';

/** A choice kept in this browser; storage can be missing or throw (as in progress.ts). */
function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // Not remembered: kept until the page closes.
    }
  };
  return [value, set] as const;
}

/** Shows a file card of the current step: opens it (Diff.tsx listens) and scrolls to it. */
export function showFile(fileId: string): void {
  window.dispatchEvent(new CustomEvent('bowi:show-file', { detail: fileId }));
  requestAnimationFrame(() =>
    document.getElementById(`review-file-${fileId}`)?.scrollIntoView({ block: 'start' }),
  );
}

/** Steps tinted alike share a colour: moved code, noise, config and other code are grey. */
const kindClass = (icon: StepIcon) =>
  `kd-${['config', 'file', 'move', 'generated', 'format'].includes(icon) ? 'grey' : icon}`;

const plainTitle = (title: string) => title.replace(/`/g, '');

export function Sidebar(props: {
  model: Model;
  mode: ReadingMode;
  flat: FlatStep[];
  current: Position;
  reviewed: Set<string>;
  go: (g: number, s?: string) => void;
  mark: (stepId: string, on: boolean) => void;
}) {
  const [view, setView] = useStored(VIEW_KEY, 'steps', ['steps', 'files']);
  const tab = (id: 'steps' | 'files', label: string, icon: ComponentChildren) => (
    <button
      role="tab"
      id={`left-tab-${id}`}
      aria-selected={view === id}
      aria-controls="left-panel"
      tabIndex={view === id ? 0 : -1}
      onClick={() => setView(id)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const other = id === 'steps' ? 'files' : 'steps';
        setView(other);
        document.getElementById(`left-tab-${other}`)?.focus();
      }}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <nav class="sidebar" aria-label="Review navigation">
      <div class="lswitch" role="tablist" aria-label="Show the review as">
        {tab(
          'steps',
          'Steps',
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M2 4l1.5 1.5L6 3M2 11l1.5 1.5L6 10M8.5 4.5H14M8.5 11.5H14" />
          </svg>,
        )}
        {tab('files', 'Files', <FolderIcon />)}
      </div>
      <div id="left-panel" role="tabpanel" aria-labelledby={`left-tab-${view}`} class="left-panel">
        {view === 'files' ? <FilesView {...props} /> : <StepsView {...props} />}
      </div>
    </nav>
  );
}

function StepsView(props: Parameters<typeof Sidebar>[0]) {
  const { model, reviewed } = props;
  const [treeOpen, setTreeOpen] = useStored(TREE_KEY, 'open', ['open', 'closed']);
  return (
    <>
      {model.plan.groups.map((g, gi) => {
        const steps = model.stepsOf(g, props.mode);
        const groupDone = steps.filter((s) => reviewed.has(s.id)).length;
        return (
          <div class="card nav-group" key={g.id}>
            <button
              class={gi === props.current.groupIndex ? 'grp on' : 'grp'}
              aria-current={gi === props.current.groupIndex}
              onClick={() => props.go(gi, steps[0]?.id)}
            >
              <span class="grp-top">
                <span class={`chip k-${g.kind}`}>{KIND_LABELS[g.kind]}</span>
                <span class="mono muted small">
                  {groupDone}/{steps.length}
                </span>
              </span>
              <span class="grp-title">
                <Inline text={g.title} />
              </span>
              <span class="muted small">{model.groupFiles(g).size} files</span>
            </button>
            {steps.map((s, i) => {
              const isDone = reviewed.has(s.id);
              const name = plainTitle(s.title);
              const isCurrent = s.id === props.current.stepId;
              const files = stepFiles(model, s);
              const open = isCurrent && treeOpen === 'open';
              return (
                <div key={s.id}>
                  <div class={isCurrent ? 'step-row on' : 'step-row'}>
                    <button
                      class="step-btn"
                      aria-current={isCurrent ? 'step' : undefined}
                      {...(isCurrent && { 'aria-expanded': open, 'aria-controls': 'step-files' })}
                      // The current step's row shows or hides where its files live.
                      onClick={() =>
                        isCurrent ? setTreeOpen(open ? 'closed' : 'open') : props.go(gi, s.id)
                      }
                    >
                      <StepIconBadge kind={model.stepIcon(g, s)} />
                      <span class="step-text">
                        <span class="step-name">
                          {i + 1}. <Inline text={s.title} />
                        </span>
                        {isCurrent ? (
                          <span class="tree-hint">
                            <Chevron open={open} />
                            {files.length} file{files.length === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span class="muted small">{model.stepSubtitle(s)}</span>
                        )}
                      </span>
                    </button>
                    {/* Marks the step without opening it. */}
                    <button
                      class="quick-mark"
                      aria-pressed={isDone}
                      aria-label={isDone ? `${name}: reviewed` : `Mark ${name} as reviewed`}
                      title={
                        isDone ? 'Reviewed: click to mark as not reviewed' : 'Mark as reviewed'
                      }
                      onClick={() => props.mark(s.id, !isDone)}
                    >
                      <ReviewedIcon done={isDone} />
                    </button>
                  </div>
                  {open && <StepTree key={s.id} model={model} group={g} step={s} files={files} />}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** The files a step's hunks are in. */
function stepFiles(model: Model, step: Step): FileChange[] {
  const ids = new Set(step.hunkIds.map((id) => model.hunks.get(id)!.fileId));
  return githubOrder([...ids].map((id) => model.files.get(id)!));
}

function StepTree(props: { model: Model; group: Group; step: Step; files: FileChange[] }) {
  const cards = new Set(props.model.viewableFiles(props.group, props.step));
  const [active, setActive] = useState<string>();
  return (
    <div class="ftree">
      <FileTree
        id="step-files"
        label="File locations in this step"
        files={props.files}
        startClosed={() => false}
        row={(f) => ({
          cls: active === f.id ? 'frow on' : 'frow',
          // Moved code and noise have no cards to jump to.
          ...(cards.has(f.id) && {
            action: () => {
              setActive(f.id);
              showFile(f.id);
            },
          }),
        })}
      />
    </div>
  );
}

function FilesView(props: Parameters<typeof Sidebar>[0]) {
  const { model, flat, current, reviewed } = props;
  const index = Math.max(
    0,
    flat.findIndex((f) => f.step.id === current.stepId),
  );
  const shown = flat[index];
  const [active, setActive] = useState<string>();
  useEffect(() => setActive(undefined), [shown?.step.id]);
  if (!shown)
    return <div class="card fview fv-empty">This pull request has no changes to review.</div>;

  const group = model.plan.groups[shown.groupIndex]!;
  const number = new Map(flat.map((f, i) => [f.step.id, i + 1]));
  const icon = (f: FlatStep) => model.stepIcon(model.plan.groups[f.groupIndex]!, f.step);
  // Each file's steps, in reading order.
  const stepsOfFile = new Map<string, FlatStep[]>();
  for (const f of flat) {
    for (const id of new Set(f.step.hunkIds.map((h) => model.hunks.get(h)!.fileId))) {
      stepsOfFile.set(id, [...(stepsOfFile.get(id) ?? []), f]);
    }
  }
  const cards = new Set(model.viewableFiles(group, shown.step));
  const isNoise = (f: FileChange) => {
    const hunks = model.hunksOfFile(f.id);
    return hunks.length > 0
      ? hunks.every((h) => h.kind === 'generated' || h.kind === 'format')
      : f.generated;
  };
  const hits = new Set([...stepsOfFile].filter(([, s]) => s.includes(shown)).map(([id]) => id));
  const stepLabel = (f: FlatStep) =>
    `Step ${number.get(f.step.id)} · ${plainTitle(f.step.title)} · ${KIND_LABELS[model.plan.groups[f.groupIndex]!.kind]}${reviewed.has(f.step.id) ? ' · reviewed' : ''}`;

  return (
    <div class="card fview">
      <div class="fv-head">
        <div class="fv-step">
          <span class={`snum ${kindClass(icon(shown))}`} aria-hidden="true">
            {index + 1}
          </span>
          <div class="fv-step-text">
            <span class="fv-of">
              Step {index + 1} of {flat.length}{' '}
              <span class={`chip k-${group.kind}`}>{KIND_LABELS[group.kind]}</span>
            </span>
            <span class="fv-title">
              <Inline text={shown.step.title} />
            </span>
          </div>
        </div>
        <div class="strip" role="group" aria-label="Steps">
          {flat.map((f, i) => {
            const cur = f === shown;
            return (
              <button
                key={f.step.id}
                class={`spill ${kindClass(icon(f))}${cur ? ' cur' : ''}`}
                aria-pressed={cur}
                aria-label={stepLabel(f)}
                title={stepLabel(f)}
                onClick={() => props.go(f.groupIndex, f.step.id)}
              >
                {i + 1}
                {reviewed.has(f.step.id) && (
                  <span class="pck" aria-hidden="true">
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="#fff"
                      stroke-width="2.2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M2 5.2l2 2 4-4.4" />
                    </svg>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <FileTree
        key={shown.step.id}
        label="All changed files"
        files={githubOrder(model.plan.files)}
        // Only the folders on the way to the step's files start open.
        startClosed={(below) => !below.some((f) => hits.has(f.id))}
        dimFolder={(below) => !below.some((f) => hits.has(f.id))}
        row={(f) => {
          const steps = stepsOfFile.get(f.id) ?? [];
          const hit = hits.has(f.id);
          const goesToCard = hit && cards.has(f.id);
          const other = steps.find((s) => s !== shown);
          const action = goesToCard
            ? () => {
                setActive(f.id);
                showFile(f.id);
              }
            : !hit && other
              ? () => props.go(other.groupIndex, other.step.id)
              : undefined;
          return {
            cls: `frow ${hit ? 'hit' : 'dim'}${active === f.id ? ' on' : ''}`,
            noise: isNoise(f),
            ...(action && { action }),
            aria: `${f.path}, ${steps.length ? `step ${steps.map((s) => number.get(s.step.id)).join(' and ')}` : 'no step'}${hit ? ', in this step' : action ? ', go to its step' : ''}`,
            chips: steps.map((s) => ({
              n: number.get(s.step.id)!,
              cls: `sb ${kindClass(icon(s))}${s === shown ? ' cur' : ''}`,
              done: reviewed.has(s.step.id),
              title: stepLabel(s),
            })),
          };
        }}
      />
    </div>
  );
}

interface Row {
  cls: string;
  action?: () => void;
  aria?: string;
  noise?: boolean;
  chips?: { n: number; cls: string; done: boolean; title: string }[];
}

/**
 * A folder tree as in the Changes tab, with guide lines and folders that fold. Single-child
 * folder chains are one row (`src/auth`). Fold state lasts until the tree is remounted.
 */
function FileTree(props: {
  id?: string;
  label: string;
  files: FileChange[];
  /** Whether a folder starts folded, from the files below it. */
  startClosed: (below: FileChange[]) => boolean;
  /** Whether a folder is shown dimmed, from the files below it. */
  dimFolder?: (below: FileChange[]) => boolean;
  row: (f: FileChange) => Row;
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const below = (d: Dir): FileChange[] => [...d.files, ...d.dirs.flatMap(below)];
  const guides = (depth: number) =>
    Array.from({ length: depth }, (_, i) => <span key={i} class="guide" aria-hidden="true" />);
  const render = (dir: Dir, depth: number, prefix: string): ComponentChildren[] => [
    ...dir.dirs.flatMap((d) => {
      const key = prefix + d.name;
      const closed = folded[key] ?? props.startClosed(below(d));
      const dim = props.dimFolder?.(below(d)) ?? false;
      return [
        <li key={`d:${key}`}>
          <button
            class={`frow fdir${dim ? ' dim' : ''}`}
            aria-expanded={!closed}
            title={key}
            onClick={() => setFolded({ ...folded, [key]: !closed })}
          >
            {guides(depth)}
            <Chevron open={!closed} />
            <FolderIcon />
            <span class="tname">{d.name}</span>
          </button>
        </li>,
        ...(closed ? [] : render(d, depth + 1, `${key}/`)),
      ];
    }),
    ...dir.files.map((f) => {
      const r = props.row(f);
      const body = (
        <>
          {guides(depth)}
          <span class="fsp" aria-hidden="true" />
          <FileStatusIcon status={f.status} />
          <span class="tname">{baseName(f.path)}</span>
          {r.noise && <span class="ntag">noise</span>}
          <span class="grow" />
          {r.chips?.map((c) => (
            <span key={c.n} class={c.cls} title={c.title} aria-hidden="true">
              {c.done && (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M2 5.2l2 2 4-4.4" />
                </svg>
              )}
              {c.n}
            </span>
          ))}
        </>
      );
      return (
        <li key={f.id}>
          {r.action ? (
            <button class={r.cls} title={f.path} aria-label={r.aria ?? f.path} onClick={r.action}>
              {body}
            </button>
          ) : (
            <span class={`${r.cls} static`} title={f.path}>
              {body}
            </span>
          )}
        </li>
      );
    }),
  ];
  return (
    <ul id={props.id} class="ftree-list" aria-label={props.label}>
      {render(buildTree(props.files), 0, '')}
    </ul>
  );
}
