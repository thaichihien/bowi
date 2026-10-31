/**
 * Description tab: the PR description as GitHub-flavored markdown, view only, then the AI's
 * overview of the changes when there is one (local changes show only the overview).
 * `source.descriptionHtml` was rendered and sanitized at report time (src/markdown.ts); it is the
 * only repository-supplied HTML the page renders as markup besides `DiffLine.html`. The overview
 * is plain text with code spans.
 */

import type { ReviewPlan } from '@bowi/core/types';
import { Inline } from './Inline.tsx';
import { formatTimestamp, initials, relativeTime, writtenBy } from './model.ts';

export function DescriptionTab({ plan, now }: { plan: ReviewPlan; now: number }) {
  return (
    <div class="wrap tab-page desc-page">
      {plan.source.kind === 'github' && <PullRequestDescription plan={plan} now={now} />}
      {plan.overview && (
        <section class="card desc" aria-label="Overview written by AI">
          <div class="desc-head">
            <strong class="ink">Overview</strong>
            <span class="chip k-ai">AI</span>
            <span>{writtenBy(plan.meta.ai)}</span>
          </div>
          <p class="overview">
            <Inline text={plan.overview} />
          </p>
        </section>
      )}
    </div>
  );
}

function PullRequestDescription({ plan, now }: { plan: ReviewPlan; now: number }) {
  const s = plan.source;
  const empty = !(s.description ?? '').trim();
  return (
    <article class="card desc" aria-label="Pull request description">
      <div class="desc-head">
        {s.author && (
          <span class="avatar" aria-hidden="true">
            {initials(s.author)}
          </span>
        )}
        <span>
          {s.author ? (
            <>
              <strong class="ink">{s.author}</strong> opened this pull request
            </>
          ) : (
            'Pull request opened'
          )}
          {s.createdAt && (
            <>
              {' '}
              <time dateTime={s.createdAt} title={formatTimestamp(s.createdAt)}>
                {relativeTime(s.createdAt, now)}
              </time>
            </>
          )}
        </span>
      </div>
      {empty ? (
        <p class="desc-empty">No description provided.</p>
      ) : s.descriptionHtml !== undefined ? (
        <div class="md" dangerouslySetInnerHTML={{ __html: s.descriptionHtml }} />
      ) : (
        <pre class="md-raw">{s.description}</pre>
      )}
    </article>
  );
}
