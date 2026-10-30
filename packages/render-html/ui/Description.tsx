/**
 * Description tab (pull requests only): the PR description as GitHub-flavored markdown, view
 * only. `source.descriptionHtml` was rendered and sanitized at report time (src/markdown.ts);
 * it is the only repository-supplied HTML the page renders as markup besides `DiffLine.html`.
 */

import type { ReviewPlan } from '@bowi/core/types';
import { formatTimestamp, initials, relativeTime } from './model.ts';

export function DescriptionTab({ plan, now }: { plan: ReviewPlan; now: number }) {
  const s = plan.source;
  const empty = !(s.description ?? '').trim();
  return (
    <div class="wrap tab-page">
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
    </div>
  );
}
