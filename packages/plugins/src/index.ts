/**
 * Framework plugins (PLG-1, PLG-2). The interface lives in `@bowi/core` (`FrameworkPlugin`);
 * `defaultPlugins` are the ones the CLI tries on every run.
 */

import type { FrameworkPlugin } from '@bowi/core';
import { nestjsPlugin } from './nestjs.ts';

export { nestjsPlugin } from './nestjs.ts';

export const defaultPlugins: FrameworkPlugin[] = [nestjsPlugin];
