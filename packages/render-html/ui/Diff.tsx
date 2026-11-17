/**
 * Diff rendering: file cards with hunks (UI-5) and the moved-code view (UI-6), with comments on
 * their lines (UI-25, Comments.tsx). Line text is rendered as text; only `DiffLine.html` (escaped
 * at build time) is markup.
 */

import type { DiffLine, FileChange, Hunk } from '@bowi/core/types';
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  FileCommentButton,
  FileCommentCount,
  FileComments,
  rowComments,
  useComments,
  type Variant,
} from './Comments.tsx';
import { Chevron } from './Icons.tsx';
import {
  changeLabel,
  diffBlocks,
  fileTag,
  LARGE_FILE_LINES,
  splitRows,
  type Model,
} from './model.ts';

type LineClass = 'c' | 'a' | 'd' | 'm' | 'x' | 'w';

export function FileCard({
  model,
  file,
  hunks,
  tag,
  viewed,
  onViewed,
}: {
  model: Model;
  file: FileChange;
  hunks: Hunk[];
  tag?: string;
  /** With `onViewed`, the header gets a Viewed checkbox (Review tab, UI-23). */
  viewed?: boolean;
  onViewed?: () => void;
}) {
  const symbols = [...new Set(hunks.flatMap((h) => h.symbolIds))]
    .map((id) => model.symbols.get(id)!)
    .filter(Boolean);
  const named = symbols.filter((s) => s.kind !== 'file');
  const adds = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0);
  const dels = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0);
  const label = tag ?? fileTag(file, symbols);
  // Open by default; a very large change, or one already viewed, starts closed.
  const [open, setOpen] = useState(!viewed && adds + dels <= LARGE_FILE_LINES);
  // The Review tab's file trees jump here (Sidebar.tsx): open the card on the way.
  useEffect(() => {
    if (!onViewed) return;
    const show = (e: Event) => (e as CustomEvent<string>).detail === file.id && setOpen(true);
    window.addEventListener('bowi:show-file', show);
    return () => window.removeEventListener('bowi:show-file', show);
  }, [file.id, onViewed]);
  const head = (
    <button class="file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Chevron open={open} />
      <span class="file-name">
        <span class="mono path">{file.path}</span>
        {named.length > 0 && (
          <span class="mono sym">
            {named
              .slice(0, 2)
              .map((s) => s.qualifiedName)
              .join(', ')}
            {named.length > 2 ? ` +${named.length - 2}` : ''}
          </span>
        )}
        {label && <span class="chip k-tag">{label}</span>}
        <FileCommentCount path={file.path} />
      </span>
      {!open && (
        <span class="closed-note">
          {adds + dels > LARGE_FILE_LINES ? 'Large change, ' : ''}
          {hunks.length} hunk{hunks.length === 1 ? '' : 's'} · {adds + dels} lines hidden
        </span>
      )}
      <span class="mono delta">
        <span class="plus">+{adds}</span> <span class="minus">−{dels}</span>
      </span>
    </button>
  );
  return (
    <div
      class={viewed ? 'card file is-viewed' : 'card file'}
      {...(onViewed && { id: `review-file-${file.id}` })}
    >
      {onViewed ? (
        <div class={open ? 'file-head-row' : 'file-head-row closed'}>
          {head}
          <FileCommentButton path={file.path} />
          <button
            class={viewed ? 'viewed on' : 'viewed'}
            aria-pressed={!!viewed}
            aria-label={`Viewed: ${file.path}`}
            title={viewed ? 'Viewed: click to mark as not viewed' : 'Mark as viewed and collapse'}
            onClick={() => {
              // Viewing folds the file away; marking it not viewed opens it again.
              setOpen(!!viewed);
              onViewed();
            }}
          >
            <span class="box" aria-hidden="true">
              {viewed && <CheckMark />}
            </span>
            Viewed
          </button>
        </div>
      ) : (
        <div class={open ? 'file-head-row' : 'file-head-row closed'}>
          {head}
          <FileCommentButton path={file.path} />
        </div>
      )}
      <FileComments path={file.path} variant="bowi" open={open} />
      {open && (
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

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M2 5.2l2 2 4-4.4"
        stroke="#fff"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function HunkView({
  model,
  hunk,
  path,
  wholeFile,
}: {
  model: Model;
  hunk: Hunk;
  path: string;
  wholeFile: boolean;
}) {
  // The header already names the hunk's first symbol; other symbols are named with their change.
  // A new or deleted file says so in its file tag, so its symbols need no tags.
  const tags = (wholeFile ? [] : hunk.symbolIds)
    .map((id, i) => ({ s: model.symbols.get(id), first: i === 0 }))
    .filter(({ s }) => s && s.kind !== 'file' && s.change !== 'body')
    .map(({ s, first }) => (first ? changeLabel(s!) : `${s!.name} · ${changeLabel(s!)}`));
  return (
    <div id={`hunk-${hunk.id}`}>
      <div class="mono hunk-bar">
        <HunkBarText hunk={hunk} />
        {tags.length > 0 && <span class="hunk-tags"> · {tags.join(' · ')}</span>}
      </div>
      <UnifiedLines hunk={hunk} path={path} />
    </div>
  );
}

export function Line({
  line,
  cls,
  sign,
  extra = '',
  marker,
  onMouseEnter,
}: {
  line: DiffLine;
  cls: LineClass;
  sign?: string;
  /** Comments (Comments.tsx): ` sel` for selected lines, the "+" placed over the row. */
  extra?: string;
  marker?: ComponentChildren;
  onMouseEnter?: () => void;
}) {
  const mark = sign ?? (line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ');
  return (
    <div class={`ln l-${cls}${extra}`} onMouseEnter={onMouseEnter}>
      <span class="no">{line.oldNo ?? ''}</span>
      <span class="no">{line.newNo ?? ''}</span>
      <span class="sign">{mark}</span>
      <Code line={line} />
      {line.noEol && (
        <span class="noeol" title="No newline at end of file">
          ⏎̸
        </span>
      )}
      {marker}
    </div>
  );
}

/** The `@@ −a,b +c,d @@` range, then the symbol or section the hunk is in, in bold. */
export function HunkBarText({ hunk }: { hunk: Hunk }) {
  return (
    <>
      @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{' '}
      {hunk.header && <strong class="hunk-name">{hunk.header}</strong>}
    </>
  );
}

/**
 * A hunk's lines one below the other (GitHub's unified layout). With `path`, lines take comments
 * and show the comments written on them.
 */
export function UnifiedLines({
  hunk,
  path,
  variant = 'bowi',
}: {
  hunk: Hunk;
  path?: string;
  variant?: Variant;
}) {
  const api = useComments();
  return (
    <div class="lines">
      {hunk.lines.map((l, i) => {
        const c = path === undefined ? undefined : rowComments(api, path, hunk, i, variant);
        return (
          <Fragment key={i}>
            <Line
              line={l}
              cls={l.kind === 'add' ? 'a' : l.kind === 'del' ? 'd' : 'c'}
              extra={c?.cls}
              marker={c?.marker}
              onMouseEnter={c?.onMouseEnter}
            />
            {c?.below}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * A hunk with the old version on the left and the new one on the right. A comment sits under its
 * line in that line's column, as on GitHub.
 */
export function SplitLines({
  hunk,
  path,
  variant = 'gh',
}: {
  hunk: Hunk;
  path?: string;
  variant?: Variant;
}) {
  const api = useComments();
  const parts = (index: number | undefined, column: 'old' | 'new') =>
    index === undefined || path === undefined
      ? undefined
      : rowComments(api, path, hunk, index, variant, column);
  return (
    <div class="lines split">
      {splitRows(hunk.lines).map((row, i) => {
        const left = parts(row.leftIndex, 'old');
        const right = parts(row.rightIndex, 'new');
        return (
          <Fragment key={i}>
            <div class="sr">
              <SplitCell line={row.left} side="old" comments={left} />
              <SplitCell line={row.right} side="new" comments={right} />
            </div>
            {(left?.below || right?.below) && (
              <div class="sr-below">
                <div>{left?.below}</div>
                <div>{right?.below}</div>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function SplitCell({
  line,
  side,
  comments,
}: {
  line: DiffLine | undefined;
  side: 'old' | 'new';
  comments?: ReturnType<typeof rowComments>;
}) {
  if (!line) return <div class="sd sd-e" />;
  const cls = line.kind === 'add' ? 'sd-a' : line.kind === 'del' ? 'sd-d' : 'sd-c';
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <div class={`sd ${cls}${comments?.cls ?? ''}`} onMouseEnter={comments?.onMouseEnter}>
      <span class="no">{(side === 'old' ? line.oldNo : line.newNo) ?? ''}</span>
      <span class="sign">{sign}</span>
      <Code line={line} />
      {comments?.marker}
    </div>
  );
}

function Code({ line }: { line: DiffLine }) {
  return line.html !== undefined ? (
    <span class="code" dangerouslySetInnerHTML={{ __html: line.html || ' ' }} />
  ) : (
    <span class="code">{line.text || ' '}</span>
  );
}

/**
 * The destination of a move with unchanged lines muted, lines changed during the move
 * highlighted, and the original version of each changed line struck through above it.
 */
export function MovedView({ model, to, from }: { model: Model; to: Hunk; from: Hunk }) {
  const [showOrigin, setShowOrigin] = useState(false);
  const api = useComments();
  const toFile = model.files.get(to.fileId)!;
  const fromFile = model.files.get(from.fileId)!;
  const changedTo = new Set(to.move?.changedLineIndexes ?? []);
  const originals = (from.move?.changedLineIndexes ?? []).map((i) => from.lines[i]!);
  // `index`: the row in `to`, for comments; the struck-through originals have none.
  const rows: { line: DiffLine; cls: LineClass; sign: string; index?: number }[] = [];
  let k = 0;
  to.lines.forEach((l, i) => {
    if (l.kind === 'context') rows.push({ line: l, cls: 'c', sign: ' ', index: i });
    else if (changedTo.has(i)) {
      if (k < originals.length) rows.push({ line: originals[k++]!, cls: 'w', sign: '−' });
      rows.push({ line: l, cls: 'x', sign: '~', index: i });
    } else rows.push({ line: l, cls: 'm', sign: ' ', index: i });
  });
  while (k < originals.length) rows.push({ line: originals[k++]!, cls: 'w', sign: '−' });
  const fromLine = to.move?.fromStart ?? from.oldStart;

  return (
    <>
      <div class="card file">
        <div class="file-head">
          <span class="file-name">
            <span class="mono path">{toFile.path}</span>
            <span class="chip k-tag">Moved from {fromFile.path}</span>
            <FileCommentCount path={toFile.path} />
          </span>
          <span class="mono delta">similarity {Math.round((to.move?.similarity ?? 1) * 100)}%</span>
          <FileCommentButton path={toFile.path} />
        </div>
        <FileComments path={toFile.path} variant="bowi" open />
        <div class="hunks">
          <div class="mono hunk-bar">
            moved from {fromFile.path}:{fromLine} · {to.header}
          </div>
          <div class="lines">
            {rows.map((r, i) => {
              const c =
                r.index === undefined
                  ? undefined
                  : rowComments(api, toFile.path, to, r.index, 'bowi');
              return (
                <Fragment key={i}>
                  <Line
                    line={r.line}
                    cls={r.cls}
                    sign={r.sign}
                    extra={c?.cls}
                    marker={c?.marker}
                    onMouseEnter={c?.onMouseEnter}
                  />
                  {c?.below}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <div class="legend">
        <span>
          <span class="swatch l-m" />
          Moved, unchanged
        </span>
        <span>
          <span class="swatch l-x" />
          Changed during the move
        </span>
        <span>
          <span class="swatch l-w" />
          Original line in {fromFile.path}
        </span>
        <button class="btn small" onClick={() => setShowOrigin(!showOrigin)}>
          {showOrigin ? 'Hide' : 'Show'} the removed code in {fromFile.path}
        </button>
      </div>
      {showOrigin && <FileCard model={model} file={fromFile} hunks={[from]} tag="Moved away" />}
    </>
  );
}

/** GitHub's five squares showing the share of added and deleted lines. */
export function DiffBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span class="blocks" aria-hidden="true">
      {diffBlocks(additions, deletions).map((b, i) => (
        <span key={i} class={`blk blk-${b}`} />
      ))}
    </span>
  );
}
