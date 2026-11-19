/**
 * Focus tour (M20): the changes one file at a time, in a dialog over the Review tab. Every file
 * once, in reading order, at the first step it belongs to, with all its hunks; on the left the
 * whole pull request's folder tree, folded but for the current file's path. Comments work as in
 * the step view and are the same comments: the tour is a comments surface of its own
 * (Comments.tsx), so a comment box shows only where it was opened. ← and → move and Esc closes,
 * only while focus is in the tour and never while typing. Going on past a step's last file marks
 * the step reviewed, and the Next button says so first; the last file has "Finish review", as the
 * step bar does (owner's requests). Design: the report redesign canvas.
 */

import type { FileChange, Hunk } from '@bowi/core/types';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { closedReason, noDiffNote } from './Changes.tsx';
import {
  CommentsContext,
  FileCommentButton,
  FileCommentCount,
  FileComments,
  useComments,
} from './Comments.tsx';
import { DiffBlocks, HunkView } from './Diff.tsx';
import { ArrowIcon, CheckIcon, CloseIcon } from './Icons.tsx';
import { Inline } from './Inline.tsx';
import {
  baseName,
  githubOrder,
  KIND_LABELS,
  plainTitle,
  tourFinishes,
  tourNote,
  tourStops,
  type FlatStep,
  type Model,
} from './model.ts';
import { PathName } from './Names.tsx';
import { FileTree } from './Sidebar.tsx';

export function FocusTour({
  model,
  flat,
  stepId,
  reviewed,
  mark,
  finish,
  close,
}: {
  model: Model;
  flat: FlatStep[];
  /** The current step: the tour starts at its first file. */
  stepId?: string;
  reviewed: Set<string>;
  mark: (stepId: string, on: boolean) => void;
  /** "Finish review" on the last file: as the step bar's, with the steps that file ends. */
  finish: (stepIds: string[]) => void;
  close: () => void;
}) {
  const stops = useMemo(() => tourStops(model, flat), [model, flat]);
  const finishes = useMemo(() => tourFinishes(model, flat, stops), [model, flat, stops]);
  const [index, setIndex] = useState(() => {
    const at = flat.findIndex((f) => f.step.id === stepId);
    return Math.max(0, at < 0 ? 0 : stops.findIndex((s) => s.position >= at));
  });
  const api = useComments();
  const dialog = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const files = useMemo(() => githubOrder(model.plan.files), [model]);
  const stopOf = useMemo(() => new Map(stops.map((s, i) => [s.file.id, i])), [stops]);

  // Focus moves into the tour and back to where it was.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus?.();
  }, []);

  const stop = stops[index];
  if (!stop) return null;
  const last = index === stops.length - 1;
  const go = (i: number) => {
    if (i < 0 || i >= stops.length) return;
    setIndex(i);
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  // Steps whose last file this is, not reviewed yet: going on marks them.
  const finishing = finishes[index]!.filter((f) => !reviewed.has(f.step.id));
  const forward = () => {
    if (last) {
      shut();
      finish(finishing.map((f) => f.step.id));
      return;
    }
    for (const f of finishing) mark(f.step.id, true);
    go(index + 1);
  };
  // A comment box left open in the tour closes with it, as Esc in the box would.
  const shut = () => {
    const mine = api?.on('tour');
    if (mine?.selection) mine.cancel();
    if (mine?.fileComposer) mine.closeFile();
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      shut();
    } else if (e.key === 'ArrowRight' && !last) {
      e.preventDefault();
      forward();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      go(index - 1);
    }
  };

  const group = stop.step && model.plan.groups[stop.step.groupIndex]!;
  const file = stop.file;
  const onPath = (below: FileChange[]) => below.some((f) => f.id === file.id);
  const prev = stops[index - 1];
  const next = stops[index + 1];
  const marking =
    finishing.length === 0
      ? ''
      : finishing.length === 1
        ? `Mark ${plainTitle(finishing[0]!.step.title)} reviewed · `
        : `Mark ${finishing.length} steps reviewed · `;
  return (
    <div class="tour-scrim">
      <div
        class="tour"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={onKey}
      >
        <div class="tour-head">
          {group && stop.step ? (
            <div class="tour-head-text">
              <div class="tour-meta">
                <span class={`chip k-${group.kind}`}>{KIND_LABELS[group.kind]}</span>
                <span>
                  Step {stop.position + 1} of {flat.length} · <Inline text={stop.step.step.title} />
                </span>
                {reviewed.has(stop.step.step.id) && (
                  <span class="chip k-tag">
                    <CheckIcon />
                    Reviewed
                  </span>
                )}
              </div>
              <h2 id="tour-title" class="tour-title">
                <Inline text={group.title} />
              </h2>
              <p class="tour-note">
                <Inline text={tourNote(model, group)} />
              </p>
            </div>
          ) : (
            <div class="tour-head-text">
              <div class="tour-meta">
                <span class="chip k-noise">No diff</span>
                <span>After the last step</span>
              </div>
              <h2 id="tour-title" class="tour-title">
                Files without a diff
              </h2>
              <p class="tour-note">
                Renamed, copied or binary files, and mode changes: there are no lines to read.
              </p>
            </div>
          )}
          <button class="tour-x" aria-label="Close the tour" title="Close (Esc)" onClick={shut}>
            <CloseIcon />
          </button>
        </div>
        <div class="tour-body">
          <nav class="tour-tree" aria-label="Files of the pull request">
            <FileTree
              key={file.id}
              label="All changed files"
              files={files}
              // Folded but for the folders on the current file's path; refolds on every move.
              startClosed={(below) => !onPath(below)}
              dimFolder={(below) => !onPath(below)}
              row={(f) => {
                const at = stopOf.get(f.id);
                return f.id === file.id
                  ? { cls: 'frow tour-on', aria: `${f.path}, shown` }
                  : {
                      cls: 'frow dim',
                      ...(at !== undefined && { action: () => go(at), aria: `Go to ${f.path}` }),
                    };
              }}
            />
          </nav>
          <div class="tour-file" ref={scroller}>
            <CommentsContext.Provider value={api?.on('tour')}>
              <TourFile key={file.id} model={model} file={file} />
            </CommentsContext.Provider>
          </div>
        </div>
        <div class="tour-foot">
          <button
            class="btn"
            disabled={!prev}
            aria-label={prev ? `Previous: ${prev.file.path}` : 'Previous'}
            onClick={() => go(index - 1)}
          >
            <ArrowIcon dir="left" />
            <span class="tour-lbl">
              {prev ? `Previous: ${baseName(prev.file.path)}` : 'Previous'}
            </span>
          </button>
          <span class="tour-pos">
            {index + 1} of {stops.length}
            <span class="tour-keys" aria-hidden="true">
              {' '}
              · <kbd>←</kbd> <kbd>→</kbd> to move
            </span>
          </span>
          <button
            class="btn primary"
            aria-label={next ? `${marking}Next: ${next.file.path}` : 'Finish review'}
            title={
              next && finishing.length ? 'You went through every file of this step' : undefined
            }
            onClick={forward}
          >
            {next ? (
              <span class="tour-lbl">{`${marking}Next: ${baseName(next.file.path)}`}</span>
            ) : (
              'Finish review'
            )}
            {next && <ArrowIcon dir="right" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tag on line 2 of the header, only when it matters. */
function tourTag(file: FileChange, hunks: Hunk[]): string | undefined {
  if (file.status === 'added') return 'New file';
  if (file.status === 'deleted') return 'Deleted file';
  if (file.status === 'renamed') return `Renamed from ${file.oldPath}`;
  if (file.status === 'copied') return `Copied from ${file.oldPath}`;
  if (file.status === 'binary') return 'Binary';
  if (file.generated || (hunks.length && hunks.every((h) => h.kind === 'generated')))
    return 'Generated';
  if (hunks.length && hunks.every((h) => h.kind === 'format')) return 'Formatting only';
  if (hunks.length && hunks.every((h) => h.kind === 'move'))
    return hunks.every((h) => h.newLines > 0) ? 'Moved in' : 'Moved out';
  return undefined;
}

/** The file of the tour: the step view's two-line header, pinned, then every hunk, full width. */
function TourFile({ model, file }: { model: Model; file: FileChange }) {
  const hunks = model.hunksOfFile(file.id);
  const reason = closedReason(model, file);
  const [loaded, setLoaded] = useState(!reason);
  const named = [...new Set(hunks.flatMap((h) => h.symbolIds))]
    .map((id) => model.symbols.get(id))
    .filter((s) => s && s.kind !== 'file');
  const tag = tourTag(file, hunks);
  return (
    <div class="tour-card">
      <div class="tour-fh">
        <PathName path={file.path} class="tfh-path" />
        <div class="tfh-side">
          <span class="mono delta">
            <span class="plus">+{file.additions}</span> <span class="minus">−{file.deletions}</span>
          </span>
          <DiffBlocks additions={file.additions} deletions={file.deletions} />
          <FileCommentButton path={file.path} />
        </div>
        <div class="file-sub tfh-sub">
          {tag && <span class="chip k-tag">{tag}</span>}
          {named.length > 0 && (
            <span class="mono sym">
              {named
                .slice(0, 3)
                .map((s) => s!.qualifiedName)
                .join(', ')}
              {named.length > 3 ? ` +${named.length - 3} more` : ''}
            </span>
          )}
          <span>
            {hunks.length} hunk{hunks.length === 1 ? '' : 's'}
          </span>
          <FileCommentCount path={file.path} />
        </div>
        <span class="tfh-hint">Hover a line and press + to comment</span>
      </div>
      <FileComments path={file.path} variant="bowi" open />
      {hunks.length === 0 ? (
        <p class="tour-msg">{noDiffNote(file)}</p>
      ) : !loaded ? (
        <p class="tour-msg">
          <span>{reason}</span>
          <button class="link-btn" onClick={() => setLoaded(true)}>
            Load diff
          </button>
        </p>
      ) : (
        <div class="hunks">
          {hunks.map((h) => (
            <HunkView
              key={h.id}
              model={model}
              hunk={h}
              path={file.path}
              wholeFile={file.status === 'added' || file.status === 'deleted'}
            />
          ))}
        </div>
      )}
    </div>
  );
}
