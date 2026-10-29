import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyze,
  createStageContext,
  DEFAULT_CONFIG,
  type ReviewPlan,
  type Snapshot,
} from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';

/** The email-verification plan and its snapshot (for highlighting). */
export async function fixturePlan(): Promise<{ plan: ReviewPlan; snapshot: Snapshot }> {
  const repo = buildFixtureRepo(
    emailVerification,
    join(mkdtempSync(join(tmpdir(), 'bowi-render-')), 'ev'),
  ).dir;
  const snapshot = await openLocalSnapshot({ cwd: repo });
  const plan = await analyze(
    snapshot,
    createStageContext(DEFAULT_CONFIG, { now: () => new Date(0) }),
    {
      toolVersion: 'test',
    },
  );
  return { plan, snapshot };
}
