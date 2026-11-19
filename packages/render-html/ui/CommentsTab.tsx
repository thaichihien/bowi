/**
 * Comments tab (UI-27): the review summary, every comment by file in GitHub's order with the
 * lines it is about, outdated comments last; filters (all, not on GitHub, not saved, outdated),
 * folding, "Copy all as Markdown" and "Clear all comments" (asks first, inline). Opened as a file,
 * it says how to save. What went to GitHub is read-only (UI-28). The designs are the M10 and M11
 * canvases.
 */

import { anchorLabel, reviewMarkdown, sortComments } from '@bowi/core/review';
import type { ReviewComment } from '@bowi/core/types';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BubbleIcon, ReadOnlyNote, SentChip, useComments } from './Comments.tsx';
import { Markdown, MarkdownEditor } from './Editor.tsx';
import { Chevron } from './Icons.tsx';
import { comparePaths, relativeTime, type Model } from './model.ts';
import { MarkPosted, PendingBanner } from './Post.tsx';
import { reportFolder, serveCommand, SUMMARY_ID } from './review-store.ts';

type Filter = 'all' | 'waiting' | 'pending' | 'posted' | 'unsaved' | 'outdated';

export function CommentsTab(props: {
  model: Model;
  go: (groupIndex: number, stepId?: string) => void;
  openChanges: () => void;
}) {
  const api = useComments()!;
  const { store } = api;
  const review = store.review;
  const [filter, setFilter] = useState<Filter>('all');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const unsavedShown = store.mode === 'file' || store.status === 'offline';
  const isPr = props.model.plan.source.kind === 'github';
  const all = sortComments(review.comments);
  const isPending = (c: ReviewComment) => !!c.sync?.pending;
  const isPosted = (c: ReviewComment) => !!c.sync && !c.sync.pending;
  const sentPending = all.filter(isPending).length;
  const sentPosted = all.filter(isPosted).length;
  // A filter left with nothing (after "Mark as posted", say) falls back to all.
  const shownFilter: Filter =
    (filter === 'unsaved' && !unsavedShown) ||
    (filter === 'pending' && sentPending === 0) ||
    (filter === 'posted' && sentPosted === 0)
      ? 'all'
      : filter;
  const active = all.filter((c) => c.status === 'active');
  const outdated = all.filter((c) => c.status === 'outdated');
  const unsaved = all.filter((c) => store.isUnsaved(c.id));
  const waiting = all.filter((c) => !c.sync);
  const keep: Record<Filter, (c: ReviewComment) => boolean> = {
    all: () => true,
    waiting: (c) => !c.sync,
    pending: isPending,
    posted: isPosted,
    unsaved: (c) => store.isUnsaved(c.id),
    outdated: () => true,
  };
  const listed = shownFilter === 'outdated' ? [] : active.filter(keep[shownFilter]);
  const byFile = groupByPath(listed);
  const outdatedShown = shownFilter === 'unsaved' ? [] : outdated.filter(keep[shownFilter]);
  const sentAny = sentPending + sentPosted > 0;
  const summaryClearable = review.body.trim() !== '' && !review.bodySync;
  const clearable = waiting.length > 0 || summaryClearable;
  const sections = [...byFile.keys(), ...(outdatedShown.length ? [OUTDATED] : [])];
  const allClosed = sections.length > 0 && sections.every((k) => closed.has(k));
  const fileCount = new Set(all.map((c) => c.anchor.path)).size;
  const hasAny = all.length > 0 || review.body.trim() !== '';
  const folder = reportFolder(window.location) ?? store.folder;

  const toggle = (key: string) => {
    const next = new Set(closed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setClosed(next);
  };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });

  return (
    <div class="wrap tab-page comments-page">
      <PendingBanner plan={props.model.plan} store={store} />
      {store.mode === 'file' && (unsaved.length > 0 || store.isUnsaved(SUMMARY_ID)) && (
        <div class="banner warn" role="status">
          <span class="banner-text">
            <strong>
              {unsaved.length > 0
                ? `${unsaved.length} comment${unsaved.length === 1 ? ' is' : 's are'} only in this browser.`
                : 'The review summary is only in this browser.'}
            </strong>{' '}
            This report is a plain file and cannot write <code>review-plan.json</code>. Run{' '}
            <code>{serveCommand(folder)}</code> and open the link it prints: the page there offers
            to save them.
          </span>
          <CopyText text={serveCommand(folder)} label="Copy command" />
        </div>
      )}
      <div class="comments-layout">
        <nav class="card comments-side" aria-label="Comments by file">
          <div class="side-head">
            <div class="side-total">
              {all.length} comment{all.length === 1 ? '' : 's'}
            </div>
            <div class="muted small">
              {sentAny
                ? [
                    ...(sentPending ? [`${sentPending} sent as pending`] : []),
                    ...(sentPosted ? [`${sentPosted} posted`] : []),
                    `${waiting.length} not yet`,
                  ].join(' · ')
                : `on ${fileCount} file${fileCount === 1 ? '' : 's'} of ${props.model.plan.files.length}`}
            </div>
          </div>
          <div class="pills" role="radiogroup" aria-label="Show comments">
            <FilterPill id="all" label="All" n={all.length} on={shownFilter} set={setFilter} />
            {sentPending > 0 && (
              <FilterPill
                id="pending"
                label="Sent as pending"
                n={sentPending}
                on={shownFilter}
                set={setFilter}
              />
            )}
            {sentPosted > 0 && (
              <FilterPill
                id="posted"
                label="Posted"
                n={sentPosted}
                on={shownFilter}
                set={setFilter}
              />
            )}
            {isPr && (
              <FilterPill
                id="waiting"
                label="Not on GitHub"
                n={waiting.length}
                on={shownFilter}
                set={setFilter}
              />
            )}
            {unsavedShown && (
              <FilterPill
                id="unsaved"
                label="Not saved"
                n={unsaved.length}
                on={shownFilter}
                set={setFilter}
              />
            )}
            <FilterPill
              id="outdated"
              label="Outdated"
              n={outdated.length}
              on={shownFilter}
              set={setFilter}
            />
          </div>
          {shownFilter === 'all' && (
            <button class="side-row" onClick={() => scrollTo('comments-summary')}>
              <span class="side-ico" aria-hidden="true">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                >
                  <path d="M3 3.5h10M3 6.5h10M3 9.5h6" />
                </svg>
              </span>
              <span class="side-text">
                <span class="strong">Review summary</span>
                <span class="muted small">
                  {review.body.trim() ? 'Written · goes on top' : 'Not written yet'}
                </span>
              </span>
            </button>
          )}
          {shownFilter !== 'outdated' && byFile.size > 0 && <div class="side-label">Files</div>}
          {shownFilter !== 'outdated' &&
            [...byFile.entries()].map(([path, cs]) => {
              const cut = path.lastIndexOf('/') + 1;
              return (
                <button key={path} class="side-row" onClick={() => scrollTo(sectionId(path))}>
                  <span class="side-text">
                    <span class="mono side-dir">{path.slice(0, cut)}</span>
                    <span class="mono side-base">{path.slice(cut)}</span>
                  </span>
                  {cs.some((c) => store.isUnsaved(c.id)) && (
                    <span class="unsaved-dot" role="img" aria-label="Has comments not saved" />
                  )}
                  <span class="count">{cs.length}</span>
                </button>
              );
            })}
          {outdatedShown.length > 0 && (
            <>
              <div class="side-sep" />
              <button class="side-row" onClick={() => scrollTo(sectionId(OUTDATED))}>
                <span class="side-ico outdated" aria-hidden="true">
                  <ClockIcon />
                </span>
                <span class="side-text">
                  <span class="strong">Outdated</span>
                  <span class="muted small">Lines changed since</span>
                </span>
                <span class="count outdated">{outdated.length}</span>
              </button>
            </>
          )}
        </nav>

        <main class="comments-main">
          <div class="toolbar">
            <h2 class="comments-title">
              {shownFilter === 'unsaved'
                ? 'Not saved yet'
                : shownFilter === 'waiting'
                  ? 'Not on GitHub yet'
                  : shownFilter === 'pending'
                    ? 'Sent as pending'
                    : shownFilter === 'posted'
                      ? 'Posted'
                      : shownFilter === 'outdated'
                        ? 'Outdated comments'
                        : 'All comments'}
            </h2>
            {hasAny &&
              (confirm ? (
                <span class="reset-confirm" role="group" aria-label="Clear all comments">
                  <span class="small">
                    Delete {sentAny ? '' : 'all '}
                    {waiting.length} comment{waiting.length === 1 ? '' : 's'}
                    {summaryClearable ? ' and the summary' : ''}?
                    {sentAny && ` The ${sentPending + sentPosted} on GitHub stay.`}
                  </span>
                  <button
                    class="btn small danger-solid"
                    onClick={() => {
                      store.clear();
                      setConfirm(false);
                    }}
                  >
                    Delete
                  </button>
                  <button class="link-btn" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <div class="toolbar-group">
                  {shownFilter === 'pending' && <MarkPosted store={store} />}
                  {sections.length > 0 && (
                    <button
                      class="btn small"
                      onClick={() => setClosed(allClosed ? new Set() : new Set(sections))}
                    >
                      {allClosed ? 'Expand all' : 'Collapse all'}
                    </button>
                  )}
                  <button
                    class="btn small"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(reviewMarkdown(review));
                        setCopied(true);
                      } catch {
                        // No clipboard access: nothing to show.
                      }
                    }}
                  >
                    {copied ? 'Copied' : 'Copy all as Markdown'}
                  </button>
                  {clearable && (
                    <button class="btn small danger" onClick={() => setConfirm(true)}>
                      Clear all comments
                    </button>
                  )}
                </div>
              ))}
          </div>

          {!hasAny && (
            <div class="card comments-empty">
              <div class="strong">No comments yet</div>
              <div class="small">
                Hover a line in Review or Changes and press + to write one, or write the review
                summary below.
              </div>
            </div>
          )}

          {hasAny && shownFilter !== 'all' && byFile.size === 0 && outdatedShown.length === 0 && (
            <p class="comments-none" role="status">
              {EMPTY[shownFilter]}.{' '}
              <button class="link-btn" onClick={() => setFilter('all')}>
                Show all comments
              </button>
            </p>
          )}

          {shownFilter === 'all' && (
            <section id="comments-summary" class="card summary-card">
              <div class="summary-head">
                <span class="strong" id="summary-label">
                  Review summary
                </span>
                {review.bodySync && <SentChip sync={review.bodySync} />}
                {review.bodySync && <ReadOnlyNote />}
              </div>
              {review.bodySync ? (
                <Markdown text={review.body} />
              ) : (
                <>
                  <div class="muted small summary-help">
                    What you would write when submitting a review on GitHub. It goes at the top of
                    the review, and of “Copy all as Markdown”.
                  </div>
                  <MarkdownEditor
                    value={review.body}
                    onInput={(v) => store.setBody(v)}
                    label="Review summary"
                    placeholder="Sum up your review"
                    note={
                      store.isUnsaved(SUMMARY_ID)
                        ? 'Markdown is supported · not saved'
                        : store.mode === 'served'
                          ? ''
                          : 'Markdown is supported · kept in this browser'
                    }
                  />
                </>
              )}
            </section>
          )}

          {[...byFile.entries()].map(([path, cs]) => (
            <section class="card comment-section" id={sectionId(path)} key={path}>
              <SectionHead open={!closed.has(path)} toggle={() => toggle(path)} count={cs.length}>
                <span class="mono strong">{path}</span>
              </SectionHead>
              {!closed.has(path) &&
                cs.map((c) => (
                  <CommentCard key={c.id} comment={c} model={props.model} go={props.go} />
                ))}
            </section>
          ))}

          {outdatedShown.length > 0 && (
            <section class="card comment-section outdated" id={sectionId(OUTDATED)}>
              <SectionHead
                open={!closed.has(OUTDATED)}
                toggle={() => toggle(OUTDATED)}
                count={outdatedShown.length}
                outdated
              >
                <span class="outdated-title">
                  <ClockIcon />
                  Outdated
                </span>
                <span class="muted small">
                  The lines changed after these comments were written. Each keeps the code it was
                  written on.
                </span>
              </SectionHead>
              {!closed.has(OUTDATED) &&
                outdatedShown.map((c) => (
                  <CommentCard key={c.id} comment={c} model={props.model} go={props.go} />
                ))}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

/** What a filter with nothing in it says, in the middle of the list. */
const EMPTY: Record<Filter, string> = {
  all: 'No comments yet',
  waiting: 'Every comment is on GitHub',
  pending: 'No comments are waiting to be submitted on GitHub',
  posted: 'No comments posted yet',
  unsaved: 'Every comment is saved',
  outdated: 'No outdated comments',
};

const OUTDATED = '#outdated';
const sectionId = (key: string) =>
  key === OUTDATED ? 'comments-outdated' : `comments-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;

function groupByPath(comments: ReviewComment[]): Map<string, ReviewComment[]> {
  const paths = [...new Set(comments.map((c) => c.anchor.path))].sort(comparePaths);
  return new Map(paths.map((p) => [p, comments.filter((c) => c.anchor.path === p)]));
}

function FilterPill(props: {
  id: Filter;
  label: string;
  n: number;
  on: Filter;
  set: (f: Filter) => void;
}) {
  return (
    <button
      role="radio"
      class="pill"
      aria-checked={props.on === props.id}
      onClick={() => props.set(props.id)}
    >
      {props.label} <span class="count">{props.n}</span>
    </button>
  );
}

function SectionHead(props: {
  open: boolean;
  toggle: () => void;
  count: number;
  outdated?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class={props.open ? 'section-head' : 'section-head closed'}>
      <button class="section-toggle" aria-expanded={props.open} onClick={props.toggle}>
        <Chevron open={props.open} />
        {props.children}
        <span class={props.outdated ? 'count outdated' : 'count'}>{props.count}</span>
        {!props.open && (
          <span class="muted small">
            {props.count} comment{props.count === 1 ? '' : 's'} hidden
          </span>
        )}
      </button>
    </div>
  );
}

function CommentCard(props: {
  comment: ReviewComment;
  model: Model;
  go: (groupIndex: number, stepId?: string) => void;
}) {
  const { comment: c, model } = props;
  const api = useComments()!;
  const [editing, setEditing] = useState<string>();
  const outdated = c.status === 'outdated';
  const place = outdated ? undefined : stepOf(model, c);
  const save = () => {
    if (editing === undefined || !editing.trim()) return;
    api.store.edit(c.id, editing.trim());
    setEditing(undefined);
  };
  return (
    <div class="comment-card">
      <div class="comment-top">
        {outdated && <span class="mono strong small">{c.anchor.path}</span>}
        <span class={outdated ? 'loc outdated' : 'loc'}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M3 4h10M3 8h10M3 12h6" />
          </svg>
          {anchorLabel(c.anchor)}
        </span>
        <span class="muted small">
          {relativeTime(c.updatedAt, api.now)}
          {outdated && (
            <>
              {' '}
              · written on head <span class="mono">{c.anchor.headSha.slice(0, 7)}</span>
            </>
          )}
        </span>
        {api.store.isUnsaved(c.id) && <span class="chip k-draft">Not saved</span>}
        {c.sync && <SentChip sync={c.sync} />}
        <span class="comment-actions">
          {c.sync && <ReadOnlyNote />}
          {place && (
            <a
              class="go-link"
              href={`#${place.stepId}`}
              onClick={(e) => {
                e.preventDefault();
                props.go(place.groupIndex, place.stepId);
              }}
            >
              Review · step {place.number}
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M6 3l5 5-5 5" />
              </svg>
            </a>
          )}
          {editing === undefined && !c.sync && (
            <>
              <button
                class="icon-btn"
                aria-label="Edit comment"
                title="Edit"
                onClick={() => setEditing(c.body)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10.5 2.5l3 3L6 13H3v-3z" />
                </svg>
              </button>
              <button
                class="icon-btn delete"
                aria-label="Delete comment"
                title="Delete"
                onClick={() => api.remove(c.id)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
                </svg>
              </button>
            </>
          )}
        </span>
      </div>
      {c.snippet.length > 0 && (
        <div class={outdated ? 'snippet outdated' : 'snippet'}>
          {c.snippet.map((l, i) => (
            <div key={i} class={`snip-line ${outdated ? 'o' : l.kind[0]}`}>
              <span class="no">{(l.kind === 'del' ? l.oldNo : l.newNo) ?? ''}</span>
              <span class="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
              <span class="code">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
      {editing === undefined ? (
        <Markdown text={c.body} />
      ) : (
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
      )}
    </div>
  );
}

/** The Review step showing a comment's lines (or, for a file comment, the file). */
function stepOf(
  model: Model,
  c: ReviewComment,
): { groupIndex: number; stepId: string; number: number } | undefined {
  const fileId = model.plan.files.find((f) => f.path === c.anchor.path)?.id;
  for (const [groupIndex, g] of model.plan.groups.entries()) {
    for (const [i, s] of g.steps.entries()) {
      const hit = c.anchor.hunkId
        ? s.hunkIds.includes(c.anchor.hunkId)
        : s.hunkIds.some((id) => model.hunks.get(id)?.fileId === fileId);
      if (hit) return { groupIndex, stepId: s.id, number: i + 1 };
    }
  }
  return undefined;
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // No clipboard access.
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export const ClockIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </svg>
);

export { BubbleIcon };
