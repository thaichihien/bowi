/**
 * Review tab: the reading-order switch and progress (UI-10, UI-11), groups and steps in the
 * sidebar (UI-3), the current group's card (UI-4) and the current step (UI-5..8).
 */

import type { Group } from '@bowi/core/types';
import { useState } from 'preact/hooks';
import { Chevron, ReviewedIcon, StepIconBadge } from './Icons.tsx';
import { Inline } from './Inline.tsx';
import { KIND_LABELS, type FlatStep, type Model, type ReadingMode } from './model.ts';
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
  reviewed: Set<string>;
  setReviewed: (s: Set<string>) => void;
  go: (groupIndex: number, stepId?: string) => void;
}) {
  const { model, mode, flat, current, reviewed, setReviewed, go } = props;
  const [rawOpen, setRawOpen] = useState<Set<string>>(new Set());
  const group = model.plan.groups[current.groupIndex];
  const position = flat.findIndex((f) => f.step.id === current.stepId);
  const currentStep = position >= 0 ? flat[position] : undefined;
  const next: FlatStep | undefined = position >= 0 ? flat[position + 1] : flat[0];
  const done = flat.filter((f) => reviewed.has(f.step.id)).length;
  const pct = flat.length ? Math.round((done / flat.length) * 100) : 0;

  return (
    <div class="wrap tab-page">
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
        </div>
        <div class="toolbar-group progress">
          <span class="muted small">
            <strong class="ink">
              {done} of {flat.length}
            </strong>{' '}
            steps reviewed
          </span>
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
        </div>
      </div>
      <div class="layout">
        <Sidebar model={model} mode={mode} current={current} reviewed={reviewed} go={go} />
        <main class="main">
          {group ? (
            <GroupHeader key={group.id} model={model} group={group} index={current.groupIndex} />
          ) : (
            <div class="card group-card">This pull request has no changes to review.</div>
          )}
          {group && currentStep && currentStep.groupIndex === current.groupIndex && (
            <section class="step" aria-label="Current step">
              <div class="step-head">
                <div class="step-title">
                  <StepIconBadge kind={model.stepIcon(group, currentStep.step)} />
                  <h3>
                    Step{' '}
                    {model.stepsOf(group, mode).findIndex((s) => s.id === currentStep.step.id) + 1}{' '}
                    of {model.stepsOf(group, mode).length} ·{' '}
                    <Inline text={currentStep.step.title} />
                  </h3>
                </div>
                <span class="muted small">{model.stepSubtitle(currentStep.step)}</span>
              </div>
              <StepBody
                key={currentStep.step.id}
                model={model}
                group={group}
                step={currentStep.step}
                rawOpen={rawOpen.has(currentStep.step.id)}
                toggleRaw={() => setRawOpen(toggle(rawOpen, currentStep.step.id))}
              />
              <div class="actions">
                <button
                  class={reviewed.has(currentStep.step.id) ? 'btn done' : 'btn'}
                  aria-pressed={reviewed.has(currentStep.step.id)}
                  onClick={() => setReviewed(toggle(reviewed, currentStep.step.id))}
                >
                  {reviewed.has(currentStep.step.id) ? 'Reviewed' : 'Mark as reviewed'}
                </button>
                <button
                  class="btn primary"
                  onClick={() => {
                    setReviewed(new Set(reviewed).add(currentStep.step.id));
                    if (next) go(next.groupIndex, next.step.id);
                  }}
                >
                  {next ? (
                    <>
                      Next: <Inline text={next.step.title} /> →
                    </>
                  ) : (
                    'Finish review'
                  )}
                </button>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function Sidebar(props: {
  model: Model;
  mode: ReadingMode;
  current: Position;
  reviewed: Set<string>;
  go: (g: number, s?: string) => void;
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
            {steps.map((s, i) => (
              <button
                key={s.id}
                class={s.id === props.current.stepId ? 'step-btn on' : 'step-btn'}
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
                <ReviewedIcon done={reviewed.has(s.id)} />
              </button>
            ))}
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
      </div>
      <h2>
        <Inline text={group.title} />
        {group.titleSource === 'ai' && <span class="chip k-ai">AI</span>}
      </h2>
      <p class="intent">{group.intent ?? describe(model, group)}</p>
      {hints.length > 0 && (
        <div class="hints">
          {hints.map((h) => (
            <span key={h.id} class={`hint ${h.severity}`}>
              {h.message}
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
