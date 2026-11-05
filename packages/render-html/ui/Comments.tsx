/**
 * Comments in the diffs (M10, UI-25): the "+" on a line (Shift-click or drag for a range), the
 * comment box under the last selected line, comments under the lines they are about, file
 * comments, hiding comments (all, or one; never remembered), and "Comment deleted · Undo".
 * Used by the Review tab in Bowi's look and the Changes tab in GitHub's look (`variant`).
 */

import {
  anchorFor,
  anchorLabel,
  anchorRange,
  newCommentId,
  rowShows,
  snippetOf,
  type Side,
} from '@bowi/core/review';
import type { Hunk, ReviewComment } from '@bowi/core/types';
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Markdown, MarkdownEditor } from './Editor.tsx';
import { relativeTime } from './model.ts';
import type { ReviewStore } from './review-store.ts';

export type Variant = 'bowi' | 'gh';

/** A row picked in a hunk; `column` is set in the split layout. */
interface RowPick {
  index: number;
  column?: Side;
}

interface LineSelection {
  path: string;
  hunk: Hunk;
  a: RowPick;
  b: RowPick;
}

export interface CommentsApi {
  store: ReviewStore;
  now: number;
  selection: LineSelection | undefined;
  pick(path: string, hunk: Hunk, row: RowPick, extend: boolean): void;
  dragOver(path: string, hunk: Hunk, row: RowPick): void;
  cancel(): void;
  add(body: string): void;
  draft: string;
  setDraft(text: string): void;
  fileComposer: string | undefined;
  openFile(path: string): void;
  closeFile(): void;
  addFile(path: string, body: string): void;
  fileDraft: string;
  setFileDraft(text: string): void;
  hideAll: boolean;
  setHideAll(on: boolean): void;
  isHidden(id: string): boolean;
  hide(id: string): void;
  show(ids: string[]): void;
  remove(id: string): void;
  toast: { undo(): void } | undefined;
  dismissToast(): void;
}

export const CommentsContext = createContext<CommentsApi | undefined>(undefined);
export const useComments = () => useContext(CommentsContext);

const TOAST_MS = 8000;

/** The comment state of the page; App provides it to both tabs through CommentsContext. */
export function useCommentsApi(store: ReviewStore, headSha: string, now: number): CommentsApi {
  const [selection, setSelection] = useState<LineSelection>();
  const [draft, setDraft] = useState('');
  const [fileComposer, setFileComposer] = useState<string>();
  const [fileDraft, setFileDraft] = useState('');
  const [hideAll, setHideAll] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ undo(): void; id: number }>();
  const dragging = useRef(false);

  useEffect(() => {
    const stop = () => (dragging.current = false);
    document.addEventListener('mouseup', stop);
    return () => document.removeEventListener('mouseup', stop);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const stamp = () => new Date().toISOString();
  return {
    store,
    now,
    selection,
    pick(path, hunk, row, extend) {
      dragging.current = true;
      if (extend && selection && selection.path === path && selection.hunk.id === hunk.id) {
        setSelection({ ...selection, b: row });
      } else {
        setSelection({ path, hunk, a: row, b: row });
      }
    },
    dragOver(path, hunk, row) {
      if (!dragging.current || !selection) return;
      if (selection.path !== path || selection.hunk.id !== hunk.id) return;
      if (selection.b.index !== row.index) setSelection({ ...selection, b: row });
    },
    cancel() {
      setSelection(undefined);
      setDraft('');
    },
    add(body) {
      if (!selection || !body.trim()) return;
      const { path, hunk, a, b } = selection;
      const [first, last] = a.index <= b.index ? [a, b] : [b, a];
      const at = stamp();
      store.add({
        id: newCommentId(),
        body: body.trim(),
        anchor: anchorFor(path, headSha, hunk, first, last),
        snippet: snippetOf(hunk, first.index, last.index),
        createdAt: at,
        updatedAt: at,
        status: 'active',
      });
      // What was just written is always shown.
      setHideAll(false);
      setSelection(undefined);
      setDraft('');
    },
    draft,
    setDraft,
    fileComposer,
    openFile(path) {
      setFileComposer(path);
      setFileDraft('');
    },
    closeFile() {
      setFileComposer(undefined);
      setFileDraft('');
    },
    addFile(path, body) {
      if (!body.trim()) return;
      const at = stamp();
      store.add({
        id: newCommentId(),
        body: body.trim(),
        anchor: { path, headSha },
        snippet: [],
        createdAt: at,
        updatedAt: at,
        status: 'active',
      });
      setHideAll(false);
      setFileComposer(undefined);
      setFileDraft('');
    },
    fileDraft,
    setFileDraft,
    hideAll,
    setHideAll(on) {
      setHideAll(on);
      // Showing all comments also brings back the ones hidden one by one.
      if (!on) setHidden(new Set());
    },
    isHidden: (id) => hideAll || hidden.has(id),
    hide: (id) => setHidden(new Set([...hidden, id])),
    show(ids) {
      const next = new Set(hidden);
      for (const id of ids) next.delete(id);
      setHidden(next);
      setHideAll(false);
    },
    remove(id) {
      const undo = store.remove(id);
      setToast({ undo, id: Date.now() });
    },
    toast,
    dismissToast: () => setToast(undefined),
  };
}

/** Active comments on lines of `path` whose last line is this row (in this column, for split). */
function endingAt(api: CommentsApi, path: string, hunk: Hunk, index: number, column?: Side) {
  const line = hunk.lines[index]!;
  return api.store.review.comments.filter((c) => {
    if (c.status !== 'active' || c.anchor.path !== path) return false;
    const range = anchorRange(c.anchor);
    if (!range || (column && range.end.side !== column)) return false;
    return rowShows(line, range.end);
  });
}

function inSelection(api: CommentsApi, path: string, hunk: Hunk, index: number): boolean {
  const s = api.selection;
  if (!s || s.path !== path || s.hunk.id !== hunk.id) return false;
  return index >= Math.min(s.a.index, s.b.index) && index <= Math.max(s.a.index, s.b.index);
}

/**
 * The comment parts of one diff row: its extra class (selected lines), the "+" and the badge of
 * hidden comments (both placed over the row), and what goes under it (comments, the comment box).
 */
export function rowComments(
  api: CommentsApi | undefined,
  path: string,
  hunk: Hunk,
  index: number,
  variant: Variant,
  column?: Side,
): {
  cls: string;
  marker: ComponentChildren;
  below: ComponentChildren;
  onMouseEnter?: () => void;
} {
  if (!api) return { cls: '', marker: null, below: null };
  const row = { index, ...(column && { column }) };
  const comments = endingAt(api, path, hunk, index, column);
  const shown = comments.filter((c) => !api.isHidden(c.id));
  const hidden = comments.length - shown.length;
  const line = hunk.lines[index]!;
  const no = column === 'old' || line.kind === 'del' ? line.oldNo : line.newNo;
  const name = `${column === 'old' || line.kind === 'del' ? 'old line' : 'line'} ${no}`;
  const s = api.selection;
  const composerHere =
    !!s &&
    s.path === path &&
    s.hunk.id === hunk.id &&
    Math.max(s.a.index, s.b.index) === index &&
    (!column || (s.b.column ?? 'new') === column);
  const select = (e: MouseEvent) => api.pick(path, hunk, row, e.shiftKey);
  return {
    cls: inSelection(api, path, hunk, index) ? ' sel' : '',
    onMouseEnter: () => api.dragOver(path, hunk, row),
    marker: (
      <>
        <button
          class="add-comment"
          aria-label={`Comment on ${name}`}
          title="Comment (Shift-click another line for a range)"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            select(e);
          }}
          // A keyboard press has no mouse down first.
          onClick={(e) => e.detail === 0 && select(e)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M6 2v8M2 6h8"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
        </button>
        {hidden > 0 && (
          <button
            class="hidden-badge"
            aria-label={`${hidden} hidden comment${hidden === 1 ? '' : 's'} on ${name}: show`}
            title="Hidden comments: click to show them"
            onClick={() => api.show(comments.map((c) => c.id))}
          >
            <BubbleIcon size={12} />
            {hidden}
          </button>
        )}
      </>
    ),
    below:
      shown.length > 0 || composerHere ? (
        <div class={variant === 'gh' ? 'row-below gh' : 'row-below'}>
          {shown.map((c) => (
            <Thread key={c.id} comment={c} variant={variant} />
          ))}
          {composerHere && <LineComposer variant={variant} />}
        </div>
      ) : null,
  };
}

function LineComposer({ variant }: { variant: Variant }) {
  const api = useComments()!;
  const s = api.selection!;
  const [first, last] = s.a.index <= s.b.index ? [s.a, s.b] : [s.b, s.a];
  const label = anchorLabel(anchorFor(s.path, '', s.hunk, first, last));
  const where = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return (
    <div class={variant === 'gh' ? 'composer gh' : 'composer'}>
      <div class="composer-head">
        <strong>Comment on {where}</strong>
        <span class="muted small">Shift-click a line to change the range</span>
      </div>
      <MarkdownEditor
        value={api.draft}
        onInput={api.setDraft}
        label={`Comment on ${where}`}
        placeholder="Leave a comment"
        autoFocus
        onSubmit={() => api.add(api.draft)}
        onCancel={api.cancel}
        note={saveNote(api.store)}
      >
        <button class="btn small" onClick={api.cancel}>
          Cancel
        </button>
        <button
          class="btn small primary"
          disabled={!api.draft.trim()}
          onClick={() => api.add(api.draft)}
        >
          Add comment
        </button>
      </MarkdownEditor>
    </div>
  );
}

function saveNote(store: ReviewStore): string {
  return store.mode === 'served'
    ? 'Markdown is supported · saved to review-plan.json'
    : 'Markdown is supported · kept in this browser';
}

/** One comment: where it is, when, "Not saved", Hide / Edit / Delete; its text or the editor. */
export function Thread({ comment, variant }: { comment: ReviewComment; variant: Variant }) {
  const api = useComments()!;
  const [editing, setEditing] = useState<string>();
  const time = relativeTime(comment.updatedAt, api.now);
  const edited = comment.updatedAt !== comment.createdAt;
  const save = () => {
    if (editing === undefined || !editing.trim()) return;
    api.store.edit(comment.id, editing.trim());
    setEditing(undefined);
  };
  return (
    <div class={variant === 'gh' ? 'thread gh' : 'thread'}>
      <div class="thread-head">
        <BubbleIcon size={14} />
        <span class="thread-where">{anchorLabel(comment.anchor)}</span>
        <time class="muted" dateTime={comment.updatedAt}>
          · {time}
          {edited ? ' · edited' : ''}
        </time>
        {api.store.isUnsaved(comment.id) && (
          <span class="chip k-draft" title="Kept in this browser until it is saved">
            Not saved
          </span>
        )}
        <span class="grow" />
        {editing === undefined && (
          <>
            <button
              class="link-btn"
              title="Hide this comment. The badge on its line shows it again."
              onClick={() => api.hide(comment.id)}
            >
              Hide
            </button>
            <button class="link-btn" onClick={() => setEditing(comment.body)}>
              Edit
            </button>
            <button class="link-btn" onClick={() => api.remove(comment.id)}>
              Delete
            </button>
          </>
        )}
      </div>
      {editing === undefined ? (
        <div class="thread-body">
          <Markdown text={comment.body} />
        </div>
      ) : (
        <div class="thread-edit">
          <MarkdownEditor
            value={editing}
            onInput={setEditing}
            label="Edit comment"
            autoFocus
            onSubmit={save}
            onCancel={() => setEditing(undefined)}
          >
            <button class="btn small" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
            <button class="btn small primary" disabled={!editing.trim()} onClick={save}>
              Save
            </button>
          </MarkdownEditor>
        </div>
      )}
    </div>
  );
}

/** Comments on a whole file, and the box to write one, under the file's header. */
export function FileComments({
  path,
  variant,
  open: fileOpen,
}: {
  path: string;
  variant: Variant;
  /** A closed file shows its comment count in the header only; the box still opens. */
  open: boolean;
}) {
  const api = useComments();
  if (!api) return null;
  const comments = api.store.review.comments.filter(
    (c) => c.status === 'active' && c.anchor.path === path && c.anchor.line === undefined,
  );
  const shown = fileOpen ? comments.filter((c) => !api.isHidden(c.id)) : [];
  const open = api.fileComposer === path;
  if (shown.length === 0 && !open) return null;
  return (
    <div class={variant === 'gh' ? 'file-comments gh' : 'file-comments'}>
      {shown.map((c) => (
        <Thread key={c.id} comment={c} variant={variant} />
      ))}
      {open && (
        <div class={variant === 'gh' ? 'composer gh' : 'composer'}>
          <div class="composer-head">
            <strong>Comment on the file</strong>
            <span class="mono muted small">{path}</span>
          </div>
          <MarkdownEditor
            value={api.fileDraft}
            onInput={api.setFileDraft}
            label={`Comment on ${path}`}
            placeholder="Leave a comment about this file"
            autoFocus
            onSubmit={() => api.addFile(path, api.fileDraft)}
            onCancel={api.closeFile}
            note={saveNote(api.store)}
          >
            <button class="btn small" onClick={api.closeFile}>
              Cancel
            </button>
            <button
              class="btn small primary"
              disabled={!api.fileDraft.trim()}
              onClick={() => api.addFile(path, api.fileDraft)}
            >
              Add comment
            </button>
          </MarkdownEditor>
        </div>
      )}
    </div>
  );
}

/** The file header's button that opens the box for a file comment. */
export function FileCommentButton({ path }: { path: string }) {
  const api = useComments();
  if (!api) return null;
  return (
    <button
      class="icon-btn file-comment-btn"
      aria-label={`Comment on the whole file ${path}`}
      title="Comment on the whole file"
      onClick={(e) => {
        e.stopPropagation();
        api.openFile(path);
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        <path d="M8 5.5v3M6.5 7h3" stroke-linecap="round" />
      </svg>
    </button>
  );
}

/** "2 comments" and "1 outdated" for a file's header. */
export function FileCommentCount({ path }: { path: string }) {
  const api = useComments();
  if (!api) return null;
  const mine = api.store.review.comments.filter((c) => c.anchor.path === path);
  const active = mine.filter((c) => c.status === 'active').length;
  const outdated = mine.length - active;
  if (mine.length === 0) return null;
  return (
    <span class="file-comment-count">
      {active > 0 && (
        <span class="cnote">
          <BubbleIcon size={14} />
          {active} comment{active === 1 ? '' : 's'}
        </span>
      )}
      {outdated > 0 && <span class="chip k-outdated">{outdated} outdated</span>}
    </span>
  );
}

/** "Hide comments" / "Show comments (N)" for the Review and Changes toolbars. */
export function HideCommentsToggle() {
  const api = useComments();
  if (!api) return null;
  const n = api.store.review.comments.filter((c) => c.status === 'active').length;
  if (n === 0) return null;
  return (
    <button
      class="btn small"
      aria-pressed={api.hideAll}
      title="Show or hide every comment on the diffs"
      onClick={() => api.setHideAll(!api.hideAll)}
    >
      <BubbleIcon size={16} crossed={!api.hideAll} />
      {api.hideAll ? `Show comments (${n})` : 'Hide comments'}
    </button>
  );
}

/** "Comment deleted · Undo", bottom left, away from the step buttons. */
export function UndoToast() {
  const api = useComments();
  if (!api?.toast) return null;
  const { undo } = api.toast;
  return (
    <div class="toast" role="status">
      Comment deleted
      <button
        onClick={() => {
          undo();
          api.dismissToast();
        }}
      >
        Undo
      </button>
    </div>
  );
}

export function BubbleIcon({ size, crossed }: { size: number; crossed?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      {crossed && <path d="M2 14L14 2" />}
    </svg>
  );
}
