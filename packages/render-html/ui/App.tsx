/**
 * The review page (requirement.md §7.12), ported from docs/prototype.html: header, groups and
 * steps in reading order, the current step, and the alphabetical (GitHub) comparison.
 */

import type { Group, ReviewPlan } from '@bowi/core/types';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Inline } from './Inline.tsx';
import { formatCount, KIND_LABELS, Model, type FlatStep, type ReadingMode } from './model.ts';
import { StepBody } from './StepView.tsx';

type View = 'grouped' | 'alpha';

export function App({ plan }: { plan: ReviewPlan }) {
  const model = useMemo(() => new Model(plan), [plan]);
  const initial = useMemo(() => fromHash(model), [model]);
  const [view, setView] = useState<View>(initial.view);
  const [mode, setMode] = useState<ReadingMode>('dependency');
  const flat = useMemo(() => model.flat(mode), [model, mode]);
  const [current, setCurrent] = useState<{ groupIndex: number; stepId?: string }>(
    initial.current ?? { groupIndex: 0, stepId: flat[0]?.step.id },
  );
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [rawOpen, setRawOpen] = useState<Set<string>>(new Set());

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const go = (groupIndex: number, stepId?: string) => {
    setCurrent({ groupIndex, stepId });
    setView('grouped');
    window.scrollTo?.(0, 0);
  };
  // The address bar reflects where the reviewer is, so a step can be linked and reopened.
  useEffect(() => {
    const hash =
      view === 'alpha'
        ? '#alpha'
        : current.stepId
          ? `#${current.stepId}`
          : `#${plan.groups[current.groupIndex]?.id ?? ''}`;
    if (window.location.hash !== hash) history.replaceState(null, '', hash);
  }, [view, current, plan]);

  const group = plan.groups[current.groupIndex];
  const position = flat.findIndex((f) => f.step.id === current.stepId);
  const currentStep = position >= 0 ? flat[position] : undefined;
  const next: FlatStep | undefined = position >= 0 ? flat[position + 1] : flat[0];

  return (
    <div class="page">
      <Header plan={plan} view={view} setView={setView} mode={mode} setMode={setMode} />
      {view === 'alpha' ? (
        <AlphaView model={model} flat={flat} go={go} />
      ) : (
        <div class="layout">
          <Sidebar
            model={model}
            mode={mode}
            flat={flat}
            current={current}
            reviewed={reviewed}
            go={go}
          />
          <main class="main">
            {group ? (
              <GroupHeader model={model} group={group} index={current.groupIndex} />
            ) : (
              <div class="card group-card">This pull request has no changes to review.</div>
            )}
            {group && currentStep && currentStep.groupIndex === current.groupIndex && (
              <section class="step" aria-label="Current step">
                <div class="step-head">
                  <h3>
                    Step{' '}
                    {model.stepsOf(group, mode).findIndex((s) => s.id === currentStep.step.id) + 1}{' '}
                    of {model.stepsOf(group, mode).length} ·{' '}
                    <Inline text={currentStep.step.title} />
                  </h3>
                  <span class="muted">{model.stepSubtitle(currentStep.step)}</span>
                </div>
                <StepBody
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
      )}
    </div>
  );
}

/** Initial position from the URL: `#alpha`, `#<step id>` (e.g. `#g1:service`) or `#<group id>`. */
function fromHash(model: Model): { view: View; current?: { groupIndex: number; stepId?: string } } {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (hash === 'alpha') return { view: 'alpha' };
  for (const [groupIndex, g] of model.plan.groups.entries()) {
    if (g.id === hash) return { view: 'grouped', current: { groupIndex, stepId: g.steps[0]?.id } };
    if (g.steps.some((s) => s.id === hash))
      return { view: 'grouped', current: { groupIndex, stepId: hash } };
  }
  return { view: 'grouped' };
}

function Header(props: {
  plan: ReviewPlan;
  view: View;
  setView: (v: View) => void;
  mode: ReadingMode;
  setMode: (m: ReadingMode) => void;
}) {
  const { plan } = props;
  const s = plan.source;
  return (
    <header class="header">
      <div class="header-text">
        <div class="mono muted small">
          {s.repo} · {s.kind === 'github' ? `pull request #${s.prNumber}` : 'local changes'}
        </div>
        <h1>{s.title ?? s.headRef}</h1>
        <div class="meta">
          <span class="mono">
            {s.headRef} → {s.baseRef}
          </span>
          <span>{formatCount(plan.stats.files)} files</span>
          <span class="mono">
            <span class="plus">+{formatCount(plan.stats.additions)}</span>{' '}
            <span class="minus">−{formatCount(plan.stats.deletions)}</span>
          </span>
          <span>
            <strong>{formatCount(plan.stats.reviewLines)} lines</strong> need careful reading
          </span>
        </div>
      </div>
      <div class="controls">
        <div role="group" aria-label="View" class="segs">
          <button
            class={props.view === 'grouped' ? 'seg on' : 'seg'}
            onClick={() => props.setView('grouped')}
          >
            Grouped
          </button>
          <button
            class={props.view === 'alpha' ? 'seg on' : 'seg'}
            onClick={() => props.setView('alpha')}
          >
            Alphabetical (GitHub)
          </button>
        </div>
        <div role="group" aria-label="Reading order" class="segs">
          <button
            class={props.mode === 'dependency' ? 'seg on' : 'seg'}
            onClick={() => props.setMode('dependency')}
          >
            Dependency order
          </button>
          <button
            class={props.mode === 'tests-first' ? 'seg on' : 'seg'}
            onClick={() => props.setMode('tests-first')}
          >
            Tests first
          </button>
        </div>
      </div>
    </header>
  );
}

function Sidebar(props: {
  model: Model;
  mode: ReadingMode;
  flat: FlatStep[];
  current: { groupIndex: number; stepId?: string };
  reviewed: Set<string>;
  go: (g: number, s?: string) => void;
}) {
  const { model, flat, reviewed } = props;
  const done = flat.filter((f) => reviewed.has(f.step.id)).length;
  const pct = flat.length ? Math.round((done / flat.length) * 100) : 0;
  return (
    <nav class="sidebar" aria-label="Change groups">
      <div class="progress">
        <div class="progress-label">
          <span>Review progress</span>
          <span class="mono">
            {done} / {flat.length} steps
          </span>
        </div>
        <div
          class="bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
      {model.plan.groups.map((g, gi) => {
        const steps = model.stepsOf(g, props.mode);
        const groupDone = steps.filter((s) => reviewed.has(s.id)).length;
        return (
          <div class="nav-group" key={g.id}>
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
                <StepIcon done={reviewed.has(s.id)} />
                <span class="step-text">
                  <span>
                    {i + 1}. <Inline text={s.title} />
                  </span>
                  <span class="muted small">{model.stepSubtitle(s)}</span>
                </span>
              </button>
            ))}
          </div>
        );
      })}
      <div class="mono muted tiny">
        Generated by Bowi {model.plan.tool.version}
        <br />
        head {model.plan.source.headSha.slice(0, 7)}
      </div>
    </nav>
  );
}

function StepIcon({ done }: { done: boolean }) {
  return done ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Reviewed" class="icon">
      <circle cx="8" cy="8" r="7" fill="var(--green)" />
      <path
        d="M5 8.2l2 2 4-4.4"
        fill="none"
        stroke="#fff"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Not reviewed" class="icon">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--faint)" stroke-width="1.2" />
    </svg>
  );
}

function GroupHeader({ model, group, index }: { model: Model; group: Group; index: number }) {
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
          <div class="label">Why these changes are grouped</div>
          <ul>
            {group.reasons.map((r, i) => (
              <li key={i}>
                <Inline text={r} />
              </li>
            ))}
          </ul>
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

/** UI-9: files in GitHub's order, each with where it lands in the grouped reading order. */
function AlphaView({
  model,
  flat,
  go,
}: {
  model: Model;
  flat: FlatStep[];
  go: (g: number, s?: string) => void;
}) {
  const stepIndex = new Map(flat.map((f, i) => [f.step.id, i]));
  const rows = model.plan.files.map((file, i) => {
    const hunk = model.plan.hunks.find((h) => h.fileId === file.id);
    const position = hunk ? flat.findIndex((f) => f.step.hunkIds.includes(hunk.id)) : -1;
    const target = position >= 0 ? flat[position] : undefined;
    return { i, file, target, position: target ? stepIndex.get(target.step.id)! : -1 };
  });
  return (
    <div class="alpha">
      <h2>The same pull request in GitHub's order</h2>
      <p class="intent">
        GitHub lists files alphabetically, so unrelated files come first and code is read before
        what it depends on. The right column shows where each file lands in Bowi's reading order.
        Click a row to open it there.
      </p>
      <div class="card table">
        <div class="row head">
          <span>#</span>
          <span>File</span>
          <span>Group</span>
          <span>Lines</span>
          <span>Grouped order</span>
        </div>
        {rows.map(({ i, file, target, position }) => {
          const g = target ? model.plan.groups[target.groupIndex]! : undefined;
          return (
            <button
              key={file.id}
              class="row"
              disabled={!target}
              onClick={() => target && go(target.groupIndex, target.step.id)}
            >
              <span class="mono muted">{i + 1}</span>
              <span class="mono path">{file.path}</span>
              {g ? (
                <span class={`chip k-${g.kind}`}>{KIND_LABELS[g.kind]}</span>
              ) : (
                <span class="chip k-noise">No diff</span>
              )}
              <span class="mono small">
                <span class="plus">+{file.additions}</span>{' '}
                <span class="minus">−{file.deletions}</span>
              </span>
              <span class="accent small">
                {target ? `Step ${position + 1} of ${flat.length} →` : file.status}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
