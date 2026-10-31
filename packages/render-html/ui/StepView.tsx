/** The current step: diffs, moved code, or a collapsed noise summary (UI-5..8). */

import type { Group, Hunk, Step } from '@bowi/core/types';
import { FileCard, MovedView } from './Diff.tsx';
import { Inline } from './Inline.tsx';
import { baseName, type Model } from './model.ts';

export function StepBody({
  model,
  group,
  step,
  rawOpen,
  toggleRaw,
  viewed,
}: {
  model: Model;
  group: Group;
  step: Step;
  rawOpen: boolean;
  toggleRaw: () => void;
  /** Viewed state of the step's files (`Model.viewableFiles`); only diffs of logic get it. */
  viewed?: Viewed;
}) {
  const hunks = model.hunksOf(step);
  if (group.kind === 'move') {
    const [to, from] = hunks as [Hunk, Hunk];
    return <MovedView model={model} to={to} from={from} />;
  }
  if (hunks.every((h) => h.kind !== 'logic')) {
    return (
      <>
        <NoiseNote
          model={model}
          group={group}
          step={step}
          rawOpen={rawOpen}
          toggleRaw={toggleRaw}
        />
        {rawOpen && <Files model={model} step={step} />}
      </>
    );
  }
  return (
    <>
      <Files model={model} step={step} viewed={viewed} />
      <OutsideRefs model={model} step={step} />
    </>
  );
}

export interface Viewed {
  has: (fileId: string) => boolean;
  toggle: (fileId: string) => void;
}

function Files({ model, step, viewed }: { model: Model; step: Step; viewed?: Viewed }) {
  return (
    <>
      {model.fileBlocks(step).map((b) => (
        <FileCard
          key={b.file.id + b.hunks[0]!.id}
          model={model}
          file={b.file}
          hunks={b.hunks}
          viewed={viewed?.has(b.file.id)}
          onViewed={viewed && (() => viewed.toggle(b.file.id))}
        />
      ))}
    </>
  );
}

const NOISE_HEADINGS: Record<string, string> = {
  generated: 'Generated files, hidden',
  format: 'Formatting only, hidden',
  move: 'Moved without changes, hidden',
};

function NoiseNote(props: {
  model: Model;
  group: Group;
  step: Step;
  rawOpen: boolean;
  toggleRaw: () => void;
}) {
  const { model, group, step } = props;
  const hunks = model.hunksOf(step);
  const kind = hunks[0]?.kind ?? 'generated';
  const files = [...new Set(hunks.map((h) => h.fileId))].map((id) => model.files.get(id)!);
  return (
    <div class="card note">
      <div class="note-head">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M2 9s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path d="M3 15L15 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span>{NOISE_HEADINGS[kind]}</span>
      </div>
      {files.map((f) => {
        const lines = model.summaryFor(group, f.path);
        return (
          <div class="note-file" key={f.id}>
            <div class="mono">{f.path}</div>
            {(lines.length ? lines : [defaultNote(kind, model, hunks, f.id)]).map((l, i) => (
              <div key={i}>
                <Inline text={l} />
              </div>
            ))}
          </div>
        );
      })}
      {kind === 'format' && (
        <div class="note-file">The syntax tree is the same before and after: no logic changed.</div>
      )}
      <div class="note-file">
        <button class="btn small" onClick={props.toggleRaw}>
          {props.rawOpen ? 'Hide raw diff' : 'Show raw diff'}
        </button>
      </div>
    </div>
  );
}

function defaultNote(kind: string, model: Model, hunks: Hunk[], fileId: string): string {
  if (kind !== 'move') return '';
  const h = hunks.find((x) => x.fileId === fileId)!;
  const from = model.files.get(h.move?.fromFileId ?? '')?.path;
  return from && from !== model.files.get(fileId)!.path
    ? `\`${h.header}\` moved here from ${baseName(from)}, unchanged`
    : `\`${h.header}\` moved, unchanged`;
}

/** UI-8: unchanged code outside the PR that uses the symbols changed in this step. */
function OutsideRefs({ model, step }: { model: Model; step: Step }) {
  const ids = new Set(model.hunksOf(step).flatMap((h) => h.symbolIds));
  const refs = model.plan.outsideRefs.filter((r) => ids.has(r.symbolId));
  if (refs.length === 0) return null;
  return (
    <div class="card context">
      <div class="context-title">Related code not in this PR</div>
      {refs.map((r, i) => (
        <div class="context-row" key={i}>
          <div>
            <span class="mono strong">{model.symbols.get(r.symbolId)?.qualifiedName}</span>{' '}
            <span class="mono muted">
              used at {r.path}:{r.line}
            </span>
          </div>
          <pre class="mono excerpt">{r.excerpt}</pre>
        </div>
      ))}
    </div>
  );
}
