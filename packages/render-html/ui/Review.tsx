/**
 * Review tab: the reading-order switch and progress (UI-10, UI-11), groups and steps in the
 * sidebar with a quick "reviewed" mark per step (UI-3), the current group's card (UI-4), the
 * current step with Viewed files (UI-5..8, UI-23), the floating step actions (UI-11) and the
 * keyboard: `j` / `k` next and previous step, `r` toggles reviewed (UI-13).
 */

import type { Group } from '@bowi/core/types';
import { useEffect, useState } from 'preact/hooks';
import { HideCommentsToggle } from './Comments.tsx';
import { ArrowIcon, CheckIcon, Chevron, ReviewedIcon, StepIconBadge } from './Icons.tsx';
import { FinishDialog, type FinishResult } from './Finish.tsx';
import { Inline } from './Inline.tsx';
import { KIND_LABELS, writtenBy, type FlatStep, type Model, type ReadingMode } from './model.ts';
import { emptyProgress, markStep, toggleViewed, viewedKey, type Progress } from './progress.ts';
import { StepBody } from './StepView.tsx';

export interface Position {
  groupIndex: number;
  stepId?: string;
}

const toggle = (set: Set<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export function ReviewTab(props: {
  model: Model;
  mode: ReadingMode;
  setMode: (m: ReadingMode) => void;
  flat: FlatStep[];
  current: Position;
  progress: Progress;
  updateProgress: (change: (p: Progress) => Progress) => void;
  go: (groupIndex: number, stepId?: string) => void;
  openChanges: () => void;
}) {
  const { model, mode, flat, current, progress, updateProgress, go } = props;
  const { reviewed } = progress;
  const [rawOpen, setRawOpen] = useState<Set<string>>(new Set());
  const [finish, setFinish] = useState<FinishResult>();
  const [confirmReset, setConfirmReset] = useState(false);
  const group = model.plan.groups[current.groupIndex];
  const position = flat.findIndex((f) => f.step.id === current.stepId);
  const currentStep = position >= 0 ? flat[position] : undefined;
  const done = flat.filter((f) => reviewed.has(f.step.id)).length;
  const pct = flat.length ? Math.round((done / flat.length) * 100) : 0;
  const mark = (stepId: string, on: boolean) => updateProgress((p) => markStep(p, stepId, on));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finish || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'j' || e.key === 'k') {
        const target = position < 0 ? flat[0] : flat[position + (e.key === 'j' ? 1 : -1)];
        if (!target) return;
        e.preventDefault();
        go(target.groupIndex, target.step.id);
      } else if (e.key === 'r' && currentStep) {
        e.preventDefault();
        const id = currentStep.step.id;
        updateProgress((p) => markStep(p, id, !p.reviewed.has(id)));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [finish, flat, position, currentStep, go, updateProgress]);

  return (
    <div class="wrap tab-page review-page">
      <div class="toolbar">
        <div class="toolbar-group">
          <span class="muted small">Reading order</span>
          <div role="group" aria-label="Reading order" class="segs">
            <button
              class={mode === 'dependency' ? 'seg on' : 'seg'}
              aria-pressed={mode === 'dependency'}
              onClick={() => props.setMode('dependency')}
            >
              Dependency order
            </button>
            <button
              class={mode === 'tests-first' ? 'seg on' : 'seg'}
              aria-pressed={mode === 'tests-first'}
              onClick={() => props.setMode('tests-first')}
            >
              Tests first
            </button>
          </div>
          <HideCommentsToggle />
        </div>
        <div class="toolbar-group progress">
          {flat.length > 0 && done === flat.length ? (
            <span class="all-done small">
              <CheckIcon />
              All {flat.length} steps reviewed
            </span>
          ) : (
            <span class="muted small">
              <strong class="ink">
                {done} of {flat.length}
              </strong>{' '}
              steps reviewed
            </span>
          )}
          <div
            class="bar"
            role="progressbar"
            aria-label="Review progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={{ width: `${pct}%` }} />
          </div>
          {confirmReset ? (
            <span class="reset-confirm" role="group" aria-label="Start over">
              <span class="small">
                Clear {done} reviewed step{done === 1 ? '' : 's'}
                {progress.viewed.size > 0 &&
                  ` and ${progress.viewed.size} viewed file${progress.viewed.size === 1 ? '' : 's'}`}
                ?
              </span>
              <button
                class="btn small danger"
                onClick={() => {
                  updateProgress(() => emptyProgress());
                  setConfirmReset(false);
                  if (flat[0]) go(flat[0].groupIndex, flat[0].step.id);
                }}
              >
                Clear
              </button>
              <button class="link-btn" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              class="btn small"
              disabled={done === 0 && progress.viewed.size === 0}
              title="Clear reviewed steps and viewed files, and review again from the first step"
              onClick={() => setConfirmReset(true)}
            >
              Start over
            </button>
          )}
        </div>
      </div>
      <div class="layout">
        <Sidebar
          model={model}
          mode={mode}
          current={current}
          reviewed={reviewed}
          go={go}
          mark={mark}
        />
        <main class="main">
          {group ? (
            <GroupHeader key={group.id} model={model} group={group} index={current.groupIndex} />
          ) : (
            <div class="card group-card">This pull request has no changes to review.</div>
          )}
          {group && currentStep && currentStep.groupIndex === current.groupIndex && (
            <CurrentStep
              model={model}
              group={group}
              mode={mode}
              flat={flat}
              position={position}
              progress={progress}
              updateProgress={updateProgress}
              rawOpen={rawOpen.has(currentStep.step.id)}
              toggleRaw={() => setRawOpen(toggle(rawOpen, currentStep.step.id))}
              go={go}
              finish={() => {
                // Finish marks the last step, then celebrates or lists what is left (UI-24).
                const next = markStep(progress, currentStep.step.id, true);
                updateProgress((p) => markStep(p, currentStep.step.id, true));
                setFinish(
                  flat.every((f) => next.reviewed.has(f.step.id)) ? 'complete' : 'incomplete',
                );
              }}
            />
          )}
        </main>
      </div>
      {finish && (
        <FinishDialog
          model={model}
          result={finish}
          flat={flat}
          reviewed={reviewed}
          close={() => setFinish(undefined)}
          go={go}
          openChanges={props.openChanges}
        />
      )}
    </div>
  );
}

/** The current step, then the floating bar to mark it and move on or back (UI-11). */
function CurrentStep(props: {
  model: Model;
  group: Group;
  mode: ReadingMode;
  flat: FlatStep[];
  position: number;
  progress: Progress;
  updateProgress: (change: (p: Progress) => Progress) => void;
  rawOpen: boolean;
  toggleRaw: () => void;
  go: (groupIndex: number, stepId?: string) => void;
  finish: () => void;
}) {
  const { model, group, flat, position, progress, updateProgress, go } = props;
  const step = flat[position]!.step;
  const prev = flat[position - 1];
  const next = flat[position + 1];
  const steps = model.stepsOf(group, props.mode);
  const isDone = progress.reviewed.has(step.id);
  const files = model.viewableFiles(group, step);
  const viewedCount = files.filter((f) => progress.viewed.has(viewedKey(step.id, f))).length;
  return (
    <section class="step" aria-label="Current step">
      <div class="step-head">
        <div class="step-title">
          <StepIconBadge kind={model.stepIcon(group, step)} />
          <h3>
            Step {steps.findIndex((s) => s.id === step.id) + 1} of {steps.length} ·{' '}
            <Inline text={step.title} />
          </h3>
        </div>
        <span class="muted small">{model.stepSubtitle(step)}</span>
      </div>
      <StepBody
        key={step.id}
        model={model}
        group={group}
        step={step}
        rawOpen={props.rawOpen}
        toggleRaw={props.toggleRaw}
        viewed={{
          has: (fileId) => progress.viewed.has(viewedKey(step.id, fileId)),
          toggle: (fileId) => updateProgress((p) => toggleViewed(p, step.id, fileId, files)),
        }}
      />
      <div class="fab" role="region" aria-label="Step actions">
        <span class="fab-pos">
          Step {position + 1} of {flat.length}
          {files.length > 0 && (
            <>
              {' '}
              · {viewedCount} of {files.length} file{files.length === 1 ? '' : 's'} viewed
            </>
          )}
        </span>
        <button
          class="btn"
          disabled={!prev}
          aria-label={prev ? `Previous: ${plainTitle(prev.step.title)}` : 'Previous'}
          title={prev ? `Previous: ${plainTitle(prev.step.title)} (k)` : 'This is the first step'}
          onClick={() => prev && go(prev.groupIndex, prev.step.id)}
        >
          <ArrowIcon dir="left" />
          <span class="fab-long">Previous</span>
        </button>
        <button
          class={isDone ? 'btn done' : 'btn'}
          aria-pressed={isDone}
          title={isDone ? 'Mark as not reviewed (r)' : 'Mark as reviewed (r)'}
          onClick={() => updateProgress((p) => markStep(p, step.id, !p.reviewed.has(step.id)))}
        >
          {isDone && <CheckIcon />}
          {isDone ? 'Reviewed' : 'Mark as reviewed'}
        </button>
        <button
          class="btn primary"
          title={
            next ? 'Mark as reviewed and go to the next step (j: next without marking)' : undefined
          }
          onClick={() => {
            if (!next) return props.finish();
            updateProgress((p) => markStep(p, step.id, true));
            go(next.groupIndex, next.step.id);
          }}
        >
          {next ? (
            <>
              <span>
                <span class="fab-long">Next: </span>
                <Inline text={next.step.title} />
              </span>
              <ArrowIcon dir="right" />
            </>
          ) : (
            'Finish review'
          )}
        </button>
      </div>
    </section>
  );
}

const plainTitle = (title: string) => title.replace(/`/g, '');

function Sidebar(props: {
  model: Model;
  mode: ReadingMode;
  current: Position;
  reviewed: Set<string>;
  go: (g: number, s?: string) => void;
  mark: (stepId: string, on: boolean) => void;
}) {
  const { model, reviewed } = props;
  return (
    <nav class="sidebar" aria-label="Change groups">
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
              return (
                <div key={s.id} class={s.id === props.current.stepId ? 'step-row on' : 'step-row'}>
                  <button
                    class="step-btn"
                    aria-current={s.id === props.current.stepId ? 'step' : undefined}
                    onClick={() => props.go(gi, s.id)}
                  >
                    <StepIconBadge kind={model.stepIcon(g, s)} />
                    <span class="step-text">
                      <span class="step-name">
                        {i + 1}. <Inline text={s.title} />
                      </span>
                      <span class="muted small">{model.stepSubtitle(s)}</span>
                    </span>
                  </button>
                  {/* Marks the step without opening it. */}
                  <button
                    class="quick-mark"
                    aria-pressed={isDone}
                    aria-label={isDone ? `${name}: reviewed` : `Mark ${name} as reviewed`}
                    title={isDone ? 'Reviewed: click to mark as not reviewed' : 'Mark as reviewed'}
                    onClick={() => props.mark(s.id, !isDone)}
                  >
                    <ReviewedIcon done={isDone} />
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function GroupHeader({ model, group, index }: { model: Model; group: Group; index: number }) {
  // Closed by default: the reasons are evidence to check when the grouping looks surprising.
  const [whyOpen, setWhyOpen] = useState(false);
  const files = model.groupFiles(group).size;
  const hints = model.plan.hints.filter((h) => h.target.groupId === group.id);
  const confidence =
    group.kind === 'noise' || group.kind === 'move' || group.confidence === 'high'
      ? undefined
      : group.confidence === 'low'
        ? 'Loosely grouped'
        : 'Medium confidence';
  return (
    <section class="card group-card">
      <div class="group-meta">
        <span class={`chip k-${group.kind}`}>{KIND_LABELS[group.kind]}</span>
        {confidence && <span class="chip k-loose">{confidence}</span>}
        <span class="muted small">
          Group {index + 1} of {model.plan.groups.length} · {files} file{files === 1 ? '' : 's'}
        </span>
        {group.titleSource === 'ai' && (
          <span class="ai-credit muted small">{writtenBy(model.plan.meta.ai)}</span>
        )}
      </div>
      <h2>
        <Inline text={group.title} />
        {group.titleSource === 'ai' && <span class="chip k-ai">AI</span>}
      </h2>
      <p class="intent">
        <Inline text={group.intent ?? describe(model, group)} />
      </p>
      {group.moveSuggestions && group.moveSuggestions.length > 0 && (
        <MoveSuggestions model={model} group={group} />
      )}
      {hints.length > 0 && (
        <div class="hints">
          {hints.map((h) => (
            <span key={h.id} class={`hint ${h.severity}`}>
              <Inline text={h.message} />
            </span>
          ))}
        </div>
      )}
      {group.reasons.length > 0 && (
        <div class="reasons">
          <button class="why" aria-expanded={whyOpen} onClick={() => setWhyOpen(!whyOpen)}>
            <Chevron open={whyOpen} />
            <span class="strong">Why these changes are grouped</span>
            <span class="muted">
              {group.reasons.length} link{group.reasons.length === 1 ? '' : 's'}
            </span>
          </button>
          {whyOpen && (
            <ul>
              {group.reasons.map((r, i) => (
                <li key={i}>
                  <Inline text={r} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {group.steps.length === 0 && group.summary && (
        <div class="reasons">
          {group.summary.split('\n').map((l, i) => (
            <div key={i} class="mono small">
              {l}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The AI's suggestions to move hunks of this group elsewhere (AI-3). Only shown: the groups stay
 * as Bowi made them. When every hunk would go to the same group, it reads as one merge.
 */
function MoveSuggestions({ model, group }: { model: Model; group: Group }) {
  const moves = group.moveSuggestions ?? [];
  const titleOf = (id: string) => model.plan.groups.find((g) => g.id === id)?.title ?? id;
  const all = group.steps.flatMap((s) => s.hunkIds);
  const target = moves[0]!.toGroupId;
  const merge =
    moves.length === all.length && moves.every((m) => m.toGroupId === target) && all.length > 1;
  const groupLink = (id: string) => (
    <a href={`#${id}`}>
      <Inline text={titleOf(id)} />
    </a>
  );
  return (
    <div class="suggestions">
      <span class="chip k-ai">AI</span>
      {merge ? (
        <p>
          Suggests reading this group together with {groupLink(target)}:{' '}
          <Inline text={moves[0]!.reason} />
        </p>
      ) : (
        <ul>
          {moves.map((m) => {
            const hunk = model.hunks.get(m.hunkId)!;
            const path = model.files.get(hunk.fileId)!.path;
            const line = hunk.newLines > 0 ? hunk.newStart : hunk.oldStart;
            const step = group.steps.find((s) => s.hunkIds.includes(m.hunkId))!;
            return (
              <li key={m.hunkId}>
                Suggests{' '}
                <a href={`#${step.id}`}>
                  <code>
                    {path}:{line}
                  </code>
                </a>{' '}
                belongs with {groupLink(m.toGroupId)}: <Inline text={m.reason} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Rule-based description when there is no AI intent. */
function describe(model: Model, group: Group): string {
  if (group.kind === 'noise') {
    return 'Changes you usually do not need to read line by line. They are collapsed here, never removed: every step can show its raw diff.';
  }
  if (group.kind === 'move') {
    return 'Code moved between places. Lines that changed during the move are highlighted; everything else is identical.';
  }
  const named = model.groupSymbols(group).filter((s) => s.kind !== 'file');
  const count = (c: string) => named.filter((s) => s.change === c).length;
  const parts = [
    [count('added'), 'new'],
    [count('signature') + count('renamed'), 'with a changed signature or name'],
    [count('body'), 'changed inside'],
    [count('deleted'), 'removed'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`);
  const files = model.groupFiles(group).size;
  return parts.length
    ? `Symbols: ${parts.join(', ')}; across ${files} file${files === 1 ? '' : 's'}.`
    : `Changes across ${files} file${files === 1 ? '' : 's'} without parsed symbols.`;
}
