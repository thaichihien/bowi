/**
 * Fixture "email-verification" (requirement.md §12.1 #1, the prototype's example).
 *
 * A NestJS-style API. The head branch adds email verification across entity, migration, mail
 * service, auth service, controller, spec and README, and also contains the noise cases the
 * engine must recognize: a regenerated package-lock.json, a Prettier-only change to
 * src/utils/date.ts, and slugify() moved from helpers.ts to string.ts with one changed line.
 *
 * Unchanged code the engine should find as outside references: AuthService.login() and
 * AdminUsersController.create().
 */

import { fileURLToPath } from 'node:url';
import type { FixtureSpec } from '../lib/git-repo.ts';

export const emailVerification: FixtureSpec = {
  name: 'email-verification',
  filesDir: fileURLToPath(new URL('./files', import.meta.url)),
  baseBranch: 'main',
  headBranch: 'feature/email-verification',
  base: [{ message: 'Initial commit', dir: 'base' }],
  head: [
    { message: 'feat(users): add email verification columns', dir: 'head-1-data' },
    { message: 'feat(auth): send verification email on register', dir: 'head-2-feature' },
    { message: 'refactor(utils): move slugify to string utils', dir: 'head-3-move' },
    { message: 'style: format date utils', dir: 'head-4-format' },
  ],
};

/** Changed paths between the merge base and head, sorted. Acceptance §12.2: 11 files. */
export const expectedChangedFiles = [
  'README.md',
  'package-lock.json',
  'src/auth/auth.controller.ts',
  'src/auth/auth.service.ts',
  'src/mail/mail.service.ts',
  'src/migrations/1730_add_email_verified.ts',
  'src/users/user.entity.ts',
  'src/utils/date.ts',
  'src/utils/helpers.ts',
  'src/utils/string.ts',
  'test/auth.service.spec.ts',
];
