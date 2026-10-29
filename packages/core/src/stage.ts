/**
 * Stage contract (requirement.md §11.1).
 *
 * Every engine stage is `(input, ctx) => Promise<output>`: typed, independently testable, and
 * free of global state. Anything a stage needs from the outside world comes through the context.
 */

import type { BowiConfig } from './config.ts';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
}

export interface StageContext {
  config: BowiConfig;
  logger: Logger;
  /** Records a non-fatal problem; collected into `ReviewPlan.meta.warnings`. */
  warn(message: string): void;
  /** Injected clock so `generatedAt` is the only time-dependent output. */
  now(): Date;
}

export type Stage<I, O> = (input: I, ctx: StageContext) => Promise<O>;

export const silentLogger: Logger = {
  debug() {},
  info() {},
};

/** A context for tests and tools: default-free, collects warnings into the given array. */
export function createStageContext(
  config: BowiConfig,
  options: { logger?: Logger; warnings?: string[]; now?: () => Date } = {},
): StageContext {
  const warnings = options.warnings ?? [];
  return {
    config,
    logger: options.logger ?? silentLogger,
    warn: (message) => {
      warnings.push(message);
    },
    now: options.now ?? (() => new Date()),
  };
}
