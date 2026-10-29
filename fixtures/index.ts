export { buildFixtureRepo } from './lib/git-repo.ts';
export { scratchRepo } from './lib/scratch.ts';
export type { BuiltFixture, FixtureCommit, FixtureSpec } from './lib/git-repo.ts';
export { emailVerification } from './email-verification/index.ts';
export { hubChange, noLinks, renameRefactor, unsupportedLanguage } from './generated/index.ts';

import { emailVerification } from './email-verification/index.ts';
import { hubChange, noLinks, renameRefactor, unsupportedLanguage } from './generated/index.ts';
import type { FixtureSpec } from './lib/git-repo.ts';

export const fixtures: Record<string, FixtureSpec> = Object.fromEntries(
  [emailVerification, hubChange, noLinks, renameRefactor, unsupportedLanguage].map((f) => [
    f.name,
    f,
  ]),
);
