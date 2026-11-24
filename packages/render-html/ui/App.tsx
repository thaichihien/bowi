/**
 * The review page (requirement.md §7.12): a header with the pull request's facts, then the tabs
 * Review (groups and steps in reading order), Description (PRs, and any report with an AI
 * overview), Commits, Changes (every file in GitHub's order) and Comments (M10). The reference
 * designs are the M5.5 and M10 canvases.
 */

import { requestWords } from '@bowi/core/review';
import type { ReviewPlan } from '@bowi/core/types';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChangesTab } from './Changes.tsx';
import { BubbleIcon, CommentsContext, UndoToast, useCommentsApi } from './Comments.tsx';
import { CommentsTab } from './CommentsTab.tsx';
import { CommitsTab } from './Commits.tsx';
import { DescriptionTab } from './Description.tsx';
import {
  BranchIcon,
  ChangesIcon,
  CommitIcon,
  DescriptionIcon,
  EyeIcon,
  MergeIcon,
  ReviewTabIcon,
} from './Icons.tsx';
import { DiffBlocks } from './Diff.tsx';
import { Inline } from './Inline.tsx';
import { formatCount, Model, type ReadingMode } from './model.ts';
import { loadProgress, progressKey, saveProgress, type Progress } from './progress.ts';
import { Dock } from './Dock.tsx';
import { ReviewTab, type Position } from './Review.tsx';
import { PostControls } from './Post.tsx';
import { ThemeButton } from './Theme.tsx';
import { reportFolder, ReviewStore, serveCommand, serverOf, type Server } from './review-store.ts';

export type Tab = 'review' | 'description' | 'commits' | 'changes' | 'comments';

export function App({
  plan,
  now,
  server: given,
}: {
  plan: ReviewPlan;
  now?: number;
  /** Where to save comments; by default the `bowi serve` this page came from, if any. */
  server?: Server;
}) {
  const model = useMemo(() => new Model(plan), [plan]);
  // Read once: a new server object on every render would make a new store each time.
  const [server] = useState(() => given ?? serverOf(window.location));
  // The store changes in place; bumping a counter re-renders the page.
  const [, setVersion] = useState(0);
  const store = useMemo(
    () => new ReviewStore(plan, server, () => setVersion((v) => v + 1)),
    [plan, server],
  );
  useEffect(() => void store.load(), [store]);
  const comments = useCommentsApi(store, plan.source.headSha, now ?? Date.now());
  const described = hasDescription(plan);
  const initial = useMemo(() => fromHash(model, window.location.hash), [model]);
  const [tab, setTab] = useState<Tab>(initial?.tab ?? 'review');
  // The report opens in the order chosen with --order or the config (CLI-7).
  const [mode, setMode] = useState<ReadingMode>(plan.meta.order ?? 'dependency');
  const flat = useMemo(() => model.flat(mode), [model, mode]);
  const [current, setCurrent] = useState<Position>(
    initial?.current ?? { groupIndex: 0, stepId: flat[0]?.step.id },
  );
  // Reviewed steps and viewed files, kept in the browser for a week (UI-12).
  const storeKey = useMemo(() => progressKey(plan), [plan]);
  const [progress, setProgress] = useState<Progress>(() =>
    loadProgress(storeKey, now ?? Date.now()),
  );
  const loaded = useRef(true);
  useEffect(() => {
    if (loaded.current) {
      loaded.current = false; // nothing changed yet: leave the stored entry as it is
      return;
    }
    saveProgress(storeKey, progress, Date.now());
  }, [progress, storeKey]);

  const go = (groupIndex: number, stepId?: string) => {
    setCurrent({ groupIndex, stepId });
    setTab('review');
    window.scrollTo?.(0, 0);
  };
  // The address bar reflects where the reviewer is, so a tab or step can be linked and reopened.
  useEffect(() => {
    const hash =
      tab !== 'review'
        ? `#${tab}`
        : current.stepId
          ? `#${current.stepId}`
          : `#${plan.groups[current.groupIndex]?.id ?? ''}`;
    if (window.location.hash !== hash) history.replaceState(null, '', hash);
  }, [tab, current, plan]);
  // Links into the page (a pasted URL, the back button); unknown anchors such as footnotes are
  // left to the browser.
  useEffect(() => {
    const onHash = () => {
      const target = fromHash(model, window.location.hash);
      if (!target) return;
      setTab(target.tab);
      if (target.current) setCurrent(target.current);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [model]);

  const shown: Tab = tab === 'description' && !described ? 'review' : tab;
  return (
    <CommentsContext.Provider value={comments}>
      <div class="page">
        <Header
          plan={plan}
          tab={shown}
          setTab={setTab}
          steps={flat.length}
          comments={store.review.comments.length}
          save={
            <div class="header-actions">
              <SaveStatus store={store} />
              <PostControls plan={plan} store={store} />
              <ThemeButton />
            </div>
          }
        />
        <SaveBanner store={store} />
        {shown === 'review' && (
          <ReviewTab
            model={model}
            mode={mode}
            setMode={setMode}
            flat={flat}
            current={current}
            progress={progress}
            // An updater, so quick clicks build on each other, never on a stale copy.
            updateProgress={setProgress}
            go={go}
            openChanges={() => {
              setTab('changes');
              window.scrollTo?.(0, 0);
            }}
          />
        )}
        {shown === 'description' && <DescriptionTab plan={plan} now={now ?? Date.now()} />}
        {shown === 'commits' && <CommitsTab plan={plan} now={now ?? Date.now()} />}
        {shown === 'changes' && <ChangesTab model={model} />}
        {shown === 'comments' && (
          <CommentsTab
            model={model}
            go={go}
            openChanges={() => {
              setTab('changes');
              window.scrollTo?.(0, 0);
            }}
          />
        )}
        {shown !== 'review' && <Dock />}
        <UndoToast />
      </div>
    </CommentsContext.Provider>
  );
}

const SAVE_LABELS: Record<ReviewStore['status'], string> = {
  file: 'Not saved · plain file',
  loading: 'Loading comments…',
  saving: 'Saving…',
  saved: 'Saved to review-plan.json',
  offline: 'bowi serve stopped',
  stale: 'Report written again',
};

/** Whether comments are safe: the pill next to the tabs, which explains how saving works. */
function SaveStatus({ store }: { store: ReviewStore }) {
  const [open, setOpen] = useState(false);
  const folder = reportFolder(window.location) ?? store.folder;
  return (
    <div class="save-status">
      <button
        class={`save-pill s-${store.status}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="dot" aria-hidden="true" />
        {SAVE_LABELS[store.status]}
      </button>
      {open && (
        <div class="save-pop" role="dialog" aria-label="How comments are saved">
          {store.mode === 'served' ? (
            <>
              <div class="strong">Comments are saved</div>
              <p>
                Every change goes into <code>review-plan.json</code> right away.
              </p>
            </>
          ) : (
            <>
              <div class="strong">Comments stay in this browser</div>
              <p>
                This report is a plain file, so it cannot write <code>review-plan.json</code>. To
                save your comments, run this and open the link it prints:
              </p>
              <pre class="cmd">{serveCommand(folder)}</pre>
              <p class="muted small">
                The comments you write now are not lost: the served page offers to save them.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Served page: drafts from this browser to save, a failed save, a report written again. */
function SaveBanner({ store }: { store: ReviewStore }) {
  const [confirm, setConfirm] = useState(false);
  const pending = store.pending;
  const folder = store.folder;
  if (store.status === 'offline') {
    return (
      <div class="wrap banner-wrap">
        <div class="banner warn" role="alert">
          <span class="banner-text">
            <strong>Could not save: bowi serve is not running.</strong> Your changes are kept in
            this browser. Start <code>{serveCommand(folder)}</code> again and open the link it
            prints: the page there offers to save them.
          </span>
          <button class="btn small" onClick={() => store.retry()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (store.status === 'stale') {
    return (
      <div class="wrap banner-wrap">
        <div class="banner warn" role="alert">
          <span class="banner-text">
            <strong>The report was written again since this page was opened.</strong> Reload the
            page to see it; your changes are kept in this browser and offered there.
          </span>
          <button class="btn small" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
  if (!pending) return null;
  const n = pending.count;
  return (
    <div class="wrap banner-wrap">
      <div class="banner info" role="status">
        <span class="banner-text">
          <strong>
            {n} change{n === 1 ? '' : 's'} written in this browser {n === 1 ? 'is' : 'are'} not in
            review-plan.json yet.
          </strong>{' '}
          {n === 1 ? 'It was' : 'They were'} made while this report was opened as a file.
        </span>
        {confirm ? (
          <span class="reset-confirm" role="group" aria-label="Discard changes">
            <span class="small">Discard {n === 1 ? 'it' : `all ${n}`}?</span>
            <button class="btn small danger-solid" onClick={pending.discard}>
              Discard
            </button>
            <button class="link-btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span class="banner-actions">
            <button class="btn small" onClick={() => setConfirm(true)}>
              Discard
            </button>
            <button class="btn small primary" onClick={pending.save}>
              Save {n === 1 ? 'it' : `all ${n}`}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Where a URL hash points: `#description`, `#commits`, `#changes` (`#alpha` from M4 links),
 * `#review`, `#<step id>` (e.g. `#g1:service`) or `#<group id>`. Undefined for other anchors.
 */
export function fromHash(
  model: Model,
  rawHash: string,
): { tab: Tab; current?: Position } | undefined {
  const hash = decodeURIComponent(rawHash.replace(/^#/, ''));
  if (hash === '' || hash === 'review') return { tab: 'review' };
  if (hash === 'changes' || hash === 'alpha') return { tab: 'changes' };
  if (hash === 'commits') return { tab: 'commits' };
  if (hash === 'description') return { tab: 'description' };
  if (hash === 'comments') return { tab: 'comments' };
  for (const [groupIndex, g] of model.plan.groups.entries()) {
    if (g.id === hash) return { tab: 'review', current: { groupIndex, stepId: g.steps[0]?.id } };
    if (g.steps.some((s) => s.id === hash))
      return { tab: 'review', current: { groupIndex, stepId: hash } };
  }
  return undefined;
}

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/** A pull request always has a Description tab; local changes only when the AI wrote an overview. */
function hasDescription(plan: ReviewPlan): boolean {
  return plan.source.kind !== 'local' || !!plan.overview;
}

function Header(props: {
  plan: ReviewPlan;
  tab: Tab;
  setTab: (t: Tab) => void;
  steps: number;
  comments: number;
  save: ComponentChildren;
}) {
  const { plan } = props;
  const s = plan.source;
  const words = requestWords(s);
  const isPr = !!words;
  const commits = s.totalCommits ?? s.commits.length;
  return (
    <header class="header">
      <div class="wrap header-text">
        <div class="header-top">
          <span class="mono muted small">
            {s.repo} · {words ? `${words.request} ${words.ref}` : 'local changes'}
          </span>
          <span class="mono muted tiny">
            Generated by Bowi {plan.tool.version} · head {s.headSha.slice(0, 7)}
          </span>
        </div>
        <h1>{s.title ? <Inline text={s.title} /> : s.headRef}</h1>
        <div class="meta-line">
          {isPr ? (
            <>
              <MergeIcon />
              <span>
                Merging <strong>{plural(commits, 'commit')}</strong> from
              </span>{' '}
              <span class="branch">{s.headRef}</span> <span>into</span>{' '}
              <span class="branch">{s.baseRef}</span>
            </>
          ) : (
            <>
              <BranchIcon />
              <span>
                {commits > 0 ? (
                  <>
                    <strong>{plural(commits, 'commit')}</strong>
                    {s.uncommitted && ' and uncommitted changes'}
                  </>
                ) : s.uncommitted ? (
                  <strong>Uncommitted changes</strong>
                ) : (
                  'No commits'
                )}{' '}
                on
              </span>{' '}
              <span class="branch">{s.headRef}</span> <span>compared with</span>{' '}
              <span class="branch">{s.baseRef}</span>
            </>
          )}
        </div>
        <div class="meta-line stats">
          <span>
            <span aria-hidden="true">{'\u{1F4C4}'}</span>{' '}
            <strong>{formatCount(plan.stats.files)}</strong> file
            {plan.stats.files === 1 ? '' : 's'} changed
          </span>
          <span class="sep" />
          <span class="delta-line">
            <span class="mono plus strong">+{formatCount(plan.stats.additions)}</span>{' '}
            <span class="mono minus strong">−{formatCount(plan.stats.deletions)}</span>
            <DiffBlocks additions={plan.stats.additions} deletions={plan.stats.deletions} />
          </span>
          <span class="sep" />
          <span class="careful">
            <EyeIcon />
            <span>
              <strong>{formatCount(plan.stats.reviewLines)} lines</strong> need careful reading
            </span>
          </span>
        </div>
      </div>
      <div class="wrap tabs-row">
        <nav class="tabs" aria-label="Report sections">
          <TabLink
            id="review"
            current={props.tab}
            setTab={props.setTab}
            icon={<ReviewTabIcon />}
            label="Review"
          >
            {plural(props.steps, 'step')}
          </TabLink>
          {hasDescription(plan) && (
            <TabLink
              id="description"
              current={props.tab}
              setTab={props.setTab}
              icon={<DescriptionIcon />}
              label="Description"
            />
          )}
          <TabLink
            id="commits"
            current={props.tab}
            setTab={props.setTab}
            icon={<CommitIcon />}
            label="Commits"
          >
            {formatCount(commits)}
          </TabLink>
          <TabLink
            id="changes"
            current={props.tab}
            setTab={props.setTab}
            icon={<ChangesIcon />}
            label="Changes"
          >
            {formatCount(plan.stats.files)}
          </TabLink>
          <TabLink
            id="comments"
            current={props.tab}
            setTab={props.setTab}
            icon={<BubbleIcon size={16} />}
            label="Comments"
          >
            {formatCount(props.comments)}
          </TabLink>
        </nav>
        {props.save}
      </div>
    </header>
  );
}

function TabLink(props: {
  id: Tab;
  current: Tab;
  setTab: (t: Tab) => void;
  icon: ComponentChildren;
  label: string;
  children?: ComponentChildren;
}) {
  const on = props.id === props.current;
  return (
    <a
      href={`#${props.id}`}
      class={on ? 'tab on' : 'tab'}
      aria-current={on ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        props.setTab(props.id);
      }}
    >
      {props.icon}
      {props.label}
      {props.children !== undefined && <span class="count">{props.children}</span>}
    </a>
  );
}
