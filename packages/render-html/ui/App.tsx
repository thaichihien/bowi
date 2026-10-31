/**
 * The review page (requirement.md §7.12): a header with the pull request's facts, then four
 * tabs: Review (groups and steps in reading order), Description (PRs only), Commits and Changes
 * (every file in GitHub's order). The reference design is the M5.5 canvas linked in docs/plan.md.
 */

import type { ReviewPlan } from '@bowi/core/types';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChangesTab } from './Changes.tsx';
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
import { ReviewTab, type Position } from './Review.tsx';

export type Tab = 'review' | 'description' | 'commits' | 'changes';

export function App({ plan, now }: { plan: ReviewPlan; now?: number }) {
  const model = useMemo(() => new Model(plan), [plan]);
  const isPr = plan.source.kind === 'github';
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

  const shown: Tab = tab === 'description' && !isPr ? 'review' : tab;
  return (
    <div class="page">
      <Header plan={plan} tab={shown} setTab={setTab} steps={flat.length} />
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
  for (const [groupIndex, g] of model.plan.groups.entries()) {
    if (g.id === hash) return { tab: 'review', current: { groupIndex, stepId: g.steps[0]?.id } };
    if (g.steps.some((s) => s.id === hash))
      return { tab: 'review', current: { groupIndex, stepId: hash } };
  }
  return undefined;
}

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

function Header(props: { plan: ReviewPlan; tab: Tab; setTab: (t: Tab) => void; steps: number }) {
  const { plan } = props;
  const s = plan.source;
  const isPr = s.kind === 'github';
  const commits = s.totalCommits ?? s.commits.length;
  return (
    <header class="header">
      <div class="wrap header-text">
        <div class="header-top">
          <span class="mono muted small">
            {s.repo} · {isPr ? `pull request #${s.prNumber}` : 'local changes'}
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
      <nav class="wrap tabs" aria-label="Report sections">
        <TabLink
          id="review"
          current={props.tab}
          setTab={props.setTab}
          icon={<ReviewTabIcon />}
          label="Review"
        >
          {plural(props.steps, 'step')}
        </TabLink>
        {isPr && (
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
      </nav>
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
