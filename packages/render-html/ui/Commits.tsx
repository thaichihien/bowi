/**
 * Commits tab: the PR's commits oldest first, grouped by day in the viewer's time zone, as on
 * GitHub: subject, author, "committed 2 days ago", the exact time, the short hash with a copy
 * button, and the rest of the message behind "…". Relative times are computed when the page is
 * viewed, so the plan stays deterministic.
 */

import type { Commit, ReviewPlan } from '@bowi/core/types';
import { useState } from 'preact/hooks';
import { CopyButton } from './Copy.tsx';
import { CommitIcon } from './Icons.tsx';
import { dayLabel, formatCount, formatTimestamp, initials, relativeTime } from './model.ts';

export function CommitsTab({ plan, now }: { plan: ReviewPlan; now: number }) {
  const s = plan.source;
  const days: { label: string; commits: Commit[] }[] = [];
  for (const c of s.commits) {
    const label = dayLabel(c.committedAt);
    const last = days.at(-1);
    if (last && last.label === label) last.commits.push(c);
    else days.push({ label, commits: [c] });
  }
  return (
    <div class="wrap tab-page commits">
      {days.map((d, i) => (
        <section class="day" key={i} aria-label={`Commits on ${d.label}`}>
          <div class="day-rail" aria-hidden="true">
            <CommitIcon />
            <span />
          </div>
          <div class="day-body">
            <h2 class="day-title">Commits on {d.label}</h2>
            <div class="card commit-list">
              {d.commits.map((c) => (
                <CommitRow key={c.sha} commit={c} now={now} />
              ))}
            </div>
          </div>
        </section>
      ))}
      {s.uncommitted && (
        <section class="day" aria-label="Uncommitted changes">
          <div class="day-rail" aria-hidden="true">
            <CommitIcon />
            <span />
          </div>
          <div class="day-body">
            <h2 class="day-title">Not committed yet</h2>
            <div class="card commit-list">
              <div class="commit">
                <div class="commit-main">
                  <div class="commit-subject">Uncommitted changes</div>
                  <div class="commit-meta">
                    Staged, unstaged and untracked changes in the working tree are part of this
                    review.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
      <p class="muted small commits-note">
        {s.commits.length === 0 && !s.uncommitted
          ? `No commits between ${s.baseRef} and ${s.headRef}.`
          : s.totalCommits && s.totalCommits > s.commits.length
            ? `Showing the first ${formatCount(s.commits.length)} of ${formatCount(s.totalCommits)} commits, oldest first. Times are in your time zone.`
            : 'Oldest first. Times are in your time zone.'}
      </p>
    </div>
  );
}

function CommitRow({ commit: c, now }: { commit: Commit; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="commit">
      <div class="commit-main">
        <div class="commit-subject">
          {c.subject}
          {c.body && (
            <button
              class="more"
              aria-expanded={open}
              aria-label={open ? 'Hide the full commit message' : 'Show the full commit message'}
              onClick={() => setOpen(!open)}
            >
              …
            </button>
          )}
        </div>
        {open && c.body && <pre class="commit-body">{c.body}</pre>}
        <div class="commit-meta">
          <span class="avatar small" aria-hidden="true">
            {initials(c.author.name)}
          </span>
          <strong class="ink">{c.author.login ?? c.author.name}</strong>{' '}
          {c.committer ? (
            <span>
              authored and <strong class="ink">{c.committer.login ?? c.committer.name}</strong>{' '}
              committed
            </span>
          ) : (
            <span>committed</span>
          )}{' '}
          <time dateTime={c.committedAt}>{relativeTime(c.committedAt, now)}</time>{' '}
          <span class="dot" aria-hidden="true">
            ·
          </span>{' '}
          <span class="mono timestamp">{formatTimestamp(c.committedAt)}</span>
        </div>
      </div>
      <div class="sha">
        <span class="mono">{c.sha.slice(0, 7)}</span>
        <CopyButton text={c.sha} label="Copy full commit hash" class="sha-copy" />
      </div>
    </div>
  );
}
