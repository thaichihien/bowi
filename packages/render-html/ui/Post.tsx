/**
 * "Post to GitHub" (M11, UI-28): the button next to the save status, the dialog that says what
 * goes where and as whom, and the way back to a pending review. This is the only way the page
 * sends anything to GitHub, and it does so through `bowi serve`: the token stays there. The two
 * ways of sending never look alike: "Sent as pending" (a draft only the reviewer sees) against
 * "Posted" (public). The design is the M11 canvas.
 */

import {
  anchorLabel,
  pullRequestUrl,
  sortComments,
  type PostFailure,
  type PostResult,
  type PostStatus,
} from '@bowi/core/review';
import type { ReviewComment, ReviewPlan } from '@bowi/core/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { OutIcon, useComments } from './Comments.tsx';
import { CloseIcon } from './Icons.tsx';
import { Inline } from './Inline.tsx';
import { reportFolder, serveCommand, type ReviewStore } from './review-store.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const hasPendingSent = (store: ReviewStore) =>
  !!store.review.bodySync?.pending || store.review.comments.some((c) => c.sync?.pending);

/**
 * "Open on GitHub" and "Post to GitHub", on every tab of a pull request's report. With a pending
 * review sent, "Open on GitHub" goes to the pull request's files, where it is submitted.
 */
export function PostControls({ plan, store }: { plan: ReviewPlan; store: ReviewStore }) {
  const [open, setOpen] = useState(false);
  const url = pullRequestUrl(plan.source);
  if (!url) return null;
  // Outdated ones wait in the dialog, unticked.
  const toSend = store.review.comments.filter((c) => !c.sync && c.status === 'active').length;
  return (
    <>
      <a
        class={toSend > 0 ? 'btn small' : 'btn small primary'}
        href={hasPendingSent(store) ? `${url}/files` : url}
        target="_blank"
        rel="noopener noreferrer"
        {...(hasPendingSent(store) && { title: 'Submit your pending review there' })}
      >
        Open on GitHub
        <OutIcon />
      </a>
      <button class={toSend > 0 ? 'btn small primary' : 'btn small'} onClick={() => setOpen(true)}>
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M8 12.5v-9M4 7l4-4 4 4" />
        </svg>
        Post to GitHub
        {toSend > 0 && <span class="count">{toSend}</span>}
      </button>
      {open &&
        (store.mode === 'file' ? (
          <FileNote close={() => setOpen(false)} store={store} />
        ) : (
          <PostDialog plan={plan} url={url} store={store} close={() => setOpen(false)} />
        ))}
    </>
  );
}

const NOTE_PREFIX = 'bowi:pending-note:';

/** When something was last sent as pending: what a dismissed reminder is compared with. */
function lastPendingAt(store: ReviewStore): string {
  const times = [store.review.bodySync, ...store.review.comments.map((c) => c.sync)]
    .filter((s) => s?.pending)
    .map((s) => s!.syncedAt);
  return times.reduce((a, b) => (b > a ? b : a), '');
}

/** Storage can be missing or throw, as in progress.ts: then a dismissal lasts for the page. */
function readNote(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/**
 * The Comments tab's reminder of a pending review, worded to stay true after the submit too.
 * Dismissing it is remembered in this browser until something new is sent as pending; "Open on
 * GitHub" at the top still leads there.
 */
export function PendingBanner({ plan, store }: { plan: ReviewPlan; store: ReviewStore }) {
  const url = pullRequestUrl(plan.source);
  const key = `${NOTE_PREFIX}${plan.source.repo}#${plan.source.prNumber}`;
  const [dismissed, setDismissed] = useState(() => readNote(key));
  const last = lastPendingAt(store);
  if (!url || !hasPendingSent(store) || last <= dismissed) return null;
  const dismiss = () => {
    setDismissed(last);
    try {
      window.localStorage.setItem(key, last);
    } catch {
      // Blocked storage: dismissed until the page closes.
    }
  };
  const n = store.review.comments.filter((c) => c.sync?.pending).length;
  return (
    <div class="banner warn" role="status">
      <span class="banner-text">
        <strong>
          {n > 0
            ? `${plural(n, 'comment')} ${n === 1 ? 'was' : 'were'} sent as a pending review.`
            : 'The summary was sent as a pending review.'}
        </strong>{' '}
        Nobody else can see {n === 1 ? 'it' : 'them'} until you submit the review on GitHub. Once
        you did, mark {n === 1 ? 'it' : 'them'} as posted here.
      </span>
      <span class="banner-actions">
        <a
          class="btn small primary"
          href={`${url}/files`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open on GitHub
        </a>
        <MarkPosted store={store} />
        <button class="btn small" onClick={dismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

/**
 * "I submitted it": the reviewer says the pending review was submitted on GitHub, and its
 * comments read "Posted" from then on. Bowi does not check (it reads nothing back), so one click
 * does it and "Undo" takes it back. All at once: GitHub submits a pending review as a whole.
 */
export function MarkPosted({ store }: { store: ReviewStore }) {
  const api = useComments();
  const ids = store.review.comments.filter((c) => c.sync?.pending).map((c) => c.id);
  const summary = !!store.review.bodySync?.pending;
  if (!api || store.mode !== 'served' || (ids.length === 0 && !summary)) return null;
  const what =
    ids.length > 0
      ? plural(ids.length, 'comment') + (summary ? ' and the summary' : '')
      : 'the summary';
  const mark = async () => {
    if (!(await store.setPosted({ ids, summary, posted: true }))) return;
    api.notify(`Marked ${what} as posted`, () => {
      void store.setPosted({ ids, summary, posted: false });
    });
  };
  return (
    <button
      class="btn small"
      title="Marks them as posted in Bowi, once you submitted the review on GitHub"
      onClick={() => void mark()}
    >
      I submitted it
    </button>
  );
}

/** Focus moves into a dialog and back to where it was; Escape closes it (as in Finish.tsx). */
function useDialog(close: () => void, canClose: () => boolean) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canClose()) close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
    // Set up once, for as long as the dialog is open.
  }, []);
  return first;
}

function FileNote({ close, store }: { close: () => void; store: ReviewStore }) {
  const first = useDialog(close, () => true);
  const command = serveCommand(reportFolder(window.location) ?? store.folder);
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog post-dialog" role="dialog" aria-modal="true" aria-labelledby="post-title">
        <button ref={first} class="dialog-x" aria-label="Close" onClick={close}>
          <CloseIcon />
        </button>
        <div class="post-head">
          <h2 id="post-title">Post to GitHub</h2>
        </div>
        <div class="post-body">
          <p class="dialog-text">
            This report is a plain file, so it cannot reach GitHub. Run this and open the link it
            prints, then post from there:
          </p>
          <pre class="cmd">{command}</pre>
        </div>
      </div>
    </div>
  );
}

function whereOf(c: ReviewComment): string {
  if (c.status === 'outdated' || c.anchor.line === undefined) return 'On the file';
  const label = anchorLabel(c.anchor);
  return `On ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** The first line of a comment, without Markdown marks. */
const firstLine = (body: string) =>
  (body.trim().split('\n')[0] ?? '').replace(/\*\*|`/g, '').replace(/^[#>\-*\s]+/, '');

type Phase = 'checking' | 'ready' | 'sending' | 'done';

function PostDialog(props: {
  plan: ReviewPlan;
  url: string;
  store: ReviewStore;
  close: () => void;
}) {
  const { plan, url, store, close } = props;
  const head = plan.source.headSha;
  const [phase, setPhase] = useState<Phase>('checking');
  const [status, setStatus] = useState<PostStatus>();
  const [failure, setFailure] = useState<PostFailure>();
  const [mode, setMode] = useState<'pending' | 'now'>('pending');
  // Outdated comments start unticked: their lines changed since.
  const [off, setOff] = useState<Set<string>>(
    () => new Set(store.review.comments.filter((c) => c.status === 'outdated').map((c) => c.id)),
  );
  const [summaryOff, setSummaryOff] = useState(false);
  const [result, setResult] = useState<PostResult>();
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  const first = useDialog(close, () => phaseNow.current !== 'sending');

  const [tokenOpen, setTokenOpen] = useState(false);
  // No login, or one that cannot post: the place to paste another one is open at once.
  const showToken = tokenOpen || failure?.kind === 'login' || failure?.kind === 'read-only';

  const check = async () => {
    setPhase('checking');
    setFailure(undefined);
    const answer = await store.postStatus();
    if ('kind' in answer) {
      setStatus(undefined);
      setFailure(answer);
    } else setStatus(answer);
    setPhase('ready');
  };
  useEffect(() => void check(), []);

  const review = store.review;
  const pending = status?.pending;
  const blocked = !!pending && pending.headSha !== head;
  const moved = !!status && status.headSha !== head;
  const effectiveMode = pending ? 'pending' : mode;
  const unsent = sortComments(review.comments).filter((c) => !c.sync);
  const rows = [
    ...unsent.filter((c) => c.status === 'active'),
    ...unsent.filter((c) => c.status === 'outdated'),
  ];
  const picked = rows.filter((c) => !off.has(c.id));
  const summaryWaiting = review.body.trim() !== '' && !review.bodySync;
  const summaryRow = summaryWaiting && !pending?.hasBody;
  const withSummary = summaryRow && !summaryOff;
  const already = review.comments.length - unsent.length;
  const nothing = picked.length === 0 && !withSummary;

  const what = picked.length > 0 ? plural(picked.length, 'comment') : 'the summary';
  const whatAll = picked.length > 0 && withSummary ? `${what} and the summary` : what;
  const asPending = effectiveMode === 'pending';
  const title = nothing
    ? 'Post to GitHub'
    : asPending
      ? `Send ${whatAll} as a pending review`
      : `Post ${whatAll} now`;
  const onHead = moved ? `, on head ${head.slice(0, 7)}` : '';
  const sendLabel = nothing
    ? 'Nothing to send'
    : pending
      ? `Add ${what} to your pending review`
      : asPending
        ? moved
          ? `Send ${what} as pending${onHead}`
          : `Send ${what} as a pending review`
        : `Post ${what} now${onHead}`;

  const send = async () => {
    setPhase('sending');
    setFailure(undefined);
    if (!(await store.flush())) {
      setFailure({
        kind: 'other',
        message: 'Your latest changes could not be saved, so nothing was posted.',
        ...(store.message !== undefined && { hint: store.message }),
      });
      setPhase('ready');
      return;
    }
    const answer = await store.post({
      mode: effectiveMode,
      commentIds: picked.map((c) => c.id),
      summary: withSummary,
    });
    if ('kind' in answer) {
      setFailure(answer);
      setPhase('ready');
      return;
    }
    const any = answer.sent > 0 || answer.summarySent;
    if (answer.error) {
      setFailure({
        ...answer.error,
        message:
          any || answer.error.kind === 'uncertain'
            ? answer.error.message
            : `${answer.error.message} Nothing was posted.`,
      });
      setResult(any ? answer : undefined);
      setPhase('ready');
      return;
    }
    setResult(answer);
    setPhase('done');
  };

  const canClose = phase !== 'sending';
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && canClose && close()}>
      <div class="dialog post-dialog" role="dialog" aria-modal="true" aria-labelledby="post-title">
        <button
          ref={first}
          class="dialog-x"
          aria-label="Close"
          disabled={!canClose}
          onClick={close}
        >
          <CloseIcon />
        </button>
        {phase === 'done' && result ? (
          <Done result={result} url={url} close={close} />
        ) : (
          <>
            <div class="post-head">
              <div>
                <h2 id="post-title">{title}</h2>
                {status && (
                  <div class="post-who">
                    To{' '}
                    <strong class="mono">
                      {plan.source.repo}#{plan.source.prNumber}
                    </strong>{' '}
                    as <strong>@{status.login}</strong>{' '}
                    <span class="muted">· {loginLabel(status)}</span>
                    {phase === 'ready' && !showToken && (
                      <>
                        {' · '}
                        <button class="link-btn" onClick={() => setTokenOpen(true)}>
                          Use another token
                        </button>
                      </>
                    )}
                    {phase === 'ready' && status.via === 'token' && (
                      <>
                        {' · '}
                        <button
                          class="link-btn"
                          onClick={async () => {
                            await store.forgetToken();
                            await check();
                          }}
                        >
                          Use my usual login
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            {phase === 'checking' ? (
              <div class="post-checking">
                <span class="post-spin" aria-hidden="true" />
                <span role="status">
                  Checking{' '}
                  <strong class="mono">
                    {plan.source.repo}#{plan.source.prNumber}
                  </strong>{' '}
                  on GitHub…
                </span>
              </div>
            ) : (
              <div class="post-body">
                {failure && <FailureBanner failure={failure} partial={result} />}
                {showToken && (
                  <TokenForm
                    store={store}
                    {...(status && !failure && { cancel: () => setTokenOpen(false) })}
                    done={(next) => {
                      setStatus(next);
                      setFailure(undefined);
                      setResult(undefined);
                      setTokenOpen(false);
                    }}
                  />
                )}
                {moved && (
                  <div class="banner warn" role="status">
                    <span class="banner-text">
                      <strong>This pull request has new commits.</strong> This report is on{' '}
                      <code>{head.slice(0, 7)}</code>, GitHub is on{' '}
                      <code>{status!.headSha.slice(0, 7)}</code>. Comments posted now show as
                      outdated on GitHub if their lines changed. To check, run Bowi again first:
                      comments carry over.
                    </span>
                  </div>
                )}
                {pending && !blocked && (
                  <div class="banner info" role="status">
                    <span class="banner-text">
                      <strong>
                        You already have a pending review here, with{' '}
                        {plural(pending.comments, 'comment')}.
                      </strong>{' '}
                      These join it, and you submit them together on GitHub.
                      {pending.hasBody && summaryWaiting
                        ? ' It already has a summary, so yours stays here.'
                        : ''}
                    </span>
                  </div>
                )}
                {blocked && (
                  <div class="banner warn" role="alert">
                    <span class="banner-text">
                      <strong>
                        Your pending review on GitHub is on commit{' '}
                        <code>{pending.headSha.slice(0, 7)}</code>, this report on{' '}
                        <code>{head.slice(0, 7)}</code>.
                      </strong>{' '}
                      Submit or discard that review on GitHub, then post again.
                    </span>
                  </div>
                )}
                {status && !blocked && (
                  <>
                    {!pending && !nothing && (
                      <fieldset class="post-fieldset">
                        <legend class="post-label">How it goes up</legend>
                        <div class="post-modes">
                          <label class={mode === 'pending' ? 'post-mode on' : 'post-mode'}>
                            <input
                              type="radio"
                              name="post-mode"
                              checked={mode === 'pending'}
                              onChange={() => setMode('pending')}
                            />
                            <span>
                              <strong>
                                Pending review <span class="chip k-pending">Only you</span>
                              </strong>
                              A draft on GitHub, not public yet. You still have to submit it there,
                              where you can also approve or request changes.
                            </span>
                          </label>
                          <label class={mode === 'now' ? 'post-mode on' : 'post-mode'}>
                            <input
                              type="radio"
                              name="post-mode"
                              checked={mode === 'now'}
                              onChange={() => setMode('now')}
                            />
                            <span>
                              <strong>
                                Post now <span class="chip k-posted">Public</span>
                              </strong>
                              Everyone on the pull request sees it and gets notified right away.
                              Neither approves nor requests changes.
                            </span>
                          </label>
                        </div>
                      </fieldset>
                    )}
                    <div>
                      <p class="post-label">What goes where</p>
                      <div class="post-list">
                        {summaryRow && (
                          <label class={summaryOff ? 'post-row off' : 'post-row'}>
                            <input
                              type="checkbox"
                              checked={!summaryOff}
                              onChange={() => setSummaryOff(!summaryOff)}
                            />
                            <span class="post-row-main">
                              <span class="post-row-top">Review summary</span>
                              <span class="post-row-text">{firstLine(review.body)}</span>
                            </span>
                            <span class="post-row-where">Top of the review</span>
                          </label>
                        )}
                        {rows.map((c) => {
                          const isOff = off.has(c.id);
                          return (
                            <label key={c.id} class={isOff ? 'post-row off' : 'post-row'}>
                              <input
                                type="checkbox"
                                checked={!isOff}
                                onChange={() => {
                                  const next = new Set(off);
                                  if (isOff) next.delete(c.id);
                                  else next.add(c.id);
                                  setOff(next);
                                }}
                              />
                              <span class="post-row-main">
                                <span class="post-row-top">
                                  <span class="mono">{c.anchor.path}</span>
                                  {c.status === 'outdated' && (
                                    <span class="chip k-outdated">Outdated</span>
                                  )}
                                </span>
                                <span class="post-row-text">{firstLine(c.body)}</span>
                                {c.status === 'outdated' && (
                                  <span class="post-note">
                                    Its lines changed since. If you tick it, it goes on the file,
                                    quoting the old lines.
                                  </span>
                                )}
                              </span>
                              <span class="post-row-where">{whereOf(c)}</span>
                            </label>
                          );
                        })}
                        {rows.length === 0 && !summaryRow && (
                          <div class="post-empty">
                            Nothing new to post. Every comment is already on GitHub.
                          </div>
                        )}
                      </div>
                      {already > 0 && (
                        <p class="post-note" style={{ marginTop: '8px' }}>
                          {plural(already, 'comment')} already on GitHub, not sent again.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            <div class="post-foot">
              {status && !blocked && (
                <span class="post-foot-note">
                  Once posted, a comment is read-only here: you change it on GitHub. Nothing is ever
                  posted without this step.
                </span>
              )}
              <span class="post-foot-actions">
                {failure?.kind === 'uncertain' && (
                  <a class="btn" href={url} target="_blank" rel="noopener noreferrer">
                    Open the pull request
                  </a>
                )}
                {failure?.kind !== 'uncertain' && (
                  <button class="btn" disabled={!canClose} onClick={close}>
                    Cancel
                  </button>
                )}
                {status ? (
                  !blocked && (
                    <button
                      class="btn primary"
                      disabled={nothing || phase !== 'ready'}
                      onClick={() => void send()}
                    >
                      {phase === 'sending'
                        ? 'Sending…'
                        : failure && !nothing
                          ? 'Try again'
                          : sendLabel}
                    </button>
                  )
                ) : (
                  <button
                    class="btn primary"
                    disabled={phase !== 'ready'}
                    onClick={() => void check()}
                  >
                    Try again
                  </button>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** "your gh login", "GITHUB_TOKEN", "token “work”". */
function loginLabel(status: PostStatus): string {
  if (status.via === 'gh') return 'your gh login';
  if (status.via === 'GITHUB_TOKEN') return 'GITHUB_TOKEN';
  return status.tokenName ? `token “${status.tokenName}”` : 'your token';
}

/**
 * "Use another token" (§15 #73): a token of the reviewer's choice, also when `gh` or
 * `GITHUB_TOKEN` already gives a login, with an optional name to tell it apart. The server checks
 * it with GitHub, then keeps it in memory until it stops; the page forgets it at once.
 */
function TokenForm(props: {
  store: ReviewStore;
  cancel?: () => void;
  done: (status: PostStatus) => void;
}) {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PostFailure>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const use = async () => {
    setBusy(true);
    setError(undefined);
    const answer = await props.store.useToken(token.trim(), name.trim());
    setBusy(false);
    if ('kind' in answer) {
      setError(answer);
      return;
    }
    setToken('');
    props.done(answer);
  };
  return (
    <form
      class="post-token"
      aria-labelledby="post-token-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim() && !busy) void use();
      }}
    >
      <p class="post-label" id="post-token-title">
        Use another token
      </p>
      <div class="post-token-fields">
        <label class="post-field">
          <span>GitHub token</span>
          <input
            ref={input}
            type="password"
            class="mono"
            autocomplete="off"
            spellcheck={false}
            placeholder="github_pat_… or ghp_…"
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="post-field">
          <span>
            Name <span class="muted">(optional)</span>
          </span>
          <input
            type="text"
            maxLength={60}
            placeholder="e.g. work account"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <p class="post-note">
        It needs “Pull requests: write” on this repository (a classic token: the <code>repo</code>{' '}
        scope). Create a{' '}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noopener noreferrer"
        >
          fine-grained token
        </a>{' '}
        or a{' '}
        <a
          href="https://github.com/settings/tokens/new?scopes=repo&description=Bowi"
          target="_blank"
          rel="noopener noreferrer"
        >
          classic one
        </a>
        . <code>bowi serve</code> keeps it in memory until it stops; it is never saved.
      </p>
      {error && (
        <div class="banner danger" role="alert">
          <span class="banner-text">
            <strong>
              <Inline text={error.message} />
            </strong>
            {error.hint && (
              <>
                {' '}
                <Inline text={error.hint} />
              </>
            )}
          </span>
        </div>
      )}
      <div class="post-token-actions">
        {props.cancel && (
          <button type="button" class="btn small" onClick={props.cancel}>
            Keep current login
          </button>
        )}
        <button type="submit" class="btn small primary" disabled={!token.trim() || busy}>
          {busy ? 'Checking…' : 'Use this token'}
        </button>
      </div>
    </form>
  );
}

function FailureBanner(props: { failure: PostFailure; partial?: PostResult | undefined }) {
  const { failure, partial } = props;
  const sentSome = !!partial && partial.sent + Number(partial.summarySent) > 0;
  return (
    <div class={failure.kind === 'uncertain' ? 'banner warn' : 'banner danger'} role="alert">
      <span class="banner-text">
        <strong>
          <Inline text={failure.message} />
        </strong>
        {failure.hint && (
          <>
            {' '}
            <Inline text={failure.hint} />
          </>
        )}
        {sentSome && ` ${plural(partial.sent, 'comment')} went through and will not be sent again.`}
        {failure.kind === 'login' && ' Your comments stay saved in the meantime.'}
      </span>
    </div>
  );
}

function Done(props: { result: PostResult; url: string; close: () => void }) {
  const { result, url, close } = props;
  const pending = result.mode === 'pending';
  const n = result.sent;
  const subject = n > 0 ? plural(n, 'comment') : result.summarySent ? 'The summary' : 'Nothing';
  return (
    <>
      <div class="post-body">
        <div class="post-done">
          <span class={pending ? 'post-mark pending' : 'post-mark'} aria-hidden="true">
            {pending ? (
              <svg
                width="22"
                height="22"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.8V8l2.2 1.6" />
              </svg>
            ) : (
              <svg
                width="22"
                height="22"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            )}
          </span>
          <div>
            <h2 id="post-title">
              {pending
                ? `${subject} sent as a pending review. Not public yet.`
                : `${subject} posted. Public now.`}
            </h2>
            <p class="dialog-text" style={{ marginBottom: 0 }}>
              {pending
                ? 'One step left: submit the review on GitHub. Only you can see it until then. “Open on GitHub” at the top of this report takes you there. '
                : 'Everyone on the pull request can see it now. '}
              Sent comments are read-only in Bowi: to change one, edit it on GitHub.
            </p>
          </div>
        </div>
        {result.onFile.length + result.failed.length > 0 && (
          <div class="post-list">
            {result.onFile.map((f) => (
              <div class="post-result" key={f.id}>
                <span class="chip k-draft">On the file</span>
                <span>
                  <span class="mono">{f.path}</span> {f.label.toLowerCase()}. GitHub did not accept
                  this place, so the comment starts with it.
                </span>
              </div>
            ))}
            {result.failed.map((f) => (
              <div class="post-result" key={f.id}>
                <span class="chip k-draft">Not sent</span>
                <span>
                  <span class="mono">{f.path}</span> {f.label.toLowerCase()}. {f.message}. It stays
                  here, and you can edit it or try again.
                </span>
              </div>
            ))}
          </div>
        )}
        {result.summaryLeftOut && (
          <p class="post-note">Your pending review already had a summary, so yours stayed here.</p>
        )}
      </div>
      <div class="post-foot">
        <span class="post-foot-actions">
          <button class="btn" onClick={close}>
            Done
          </button>
          <a
            class="btn primary"
            href={pending ? `${url}/files` : url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on GitHub
            <OutIcon />
          </a>
        </span>
      </div>
    </>
  );
}
