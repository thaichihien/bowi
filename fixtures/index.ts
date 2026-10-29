export { buildFixtureRepo } from './lib/git-repo.ts';
export type { BuiltFixture, FixtureCommit, FixtureSpec } from './lib/git-repo.ts';
export { emailVerification } from './email-verification/index.ts';

import { emailVerification } from './email-verification/index.ts';
import type { FixtureSpec } from './lib/git-repo.ts';

export const fixtures: Record<string, FixtureSpec> = {
  [emailVerification.name]: emailVerification,
};
