/**
 * Step-by-step progress output on stderr (CLI-6, format from §11.2).
 *
 * One line per finished stage with its timing. On a terminal, a stage that takes a while (a
 * network fetch) shows a spinner line that the finished line then replaces; elsewhere (pipes,
 * CI logs) only the finished lines are written. `--quiet` prints nothing, `--verbose` adds
 * debug lines.
 */

import { performance } from 'node:perf_hooks';
import type { Logger, StageReport } from '@bowi/core';
import type { Writable } from './index.ts';

const LABELS: Record<string, string> = {
  diff: 'Diff',
  parse: 'Parsed',
  noise: 'Noise',
  symbols: 'Symbols',
  history: 'History',
  graph: 'Graph',
  group: 'Groups',
  refs: 'Callers',
  hints: 'Hints',
};

/** Spinner text for engine stages that may download from the repository's host. */
const ACTIVE: Record<string, string> = {
  history: 'Reading commit history',
  refs: 'Searching for unchanged callers',
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Only stages slower than this get a spinner, so fast runs print no flicker. */
const SPINNER_DELAY_MS = 150;

export type Progress = ReturnType<typeof createProgress>;

export function createProgress(out: Writable, options: { quiet: boolean; verbose: boolean }) {
  const interactive = !!out.isTTY && !options.quiet;
  let spinner:
    | { timer: ReturnType<typeof setInterval> | undefined; delay: ReturnType<typeof setTimeout> }
    | undefined;

  const clearSpinner = () => {
    if (!spinner) return;
    clearTimeout(spinner.delay);
    if (spinner.timer) {
      clearInterval(spinner.timer);
      out.write('\r\x1b[2K');
    }
    spinner = undefined;
  };

  const startSpinner = (active: string) => {
    if (!interactive) return;
    clearSpinner();
    let frame = 0;
    const s: NonNullable<typeof spinner> = {
      timer: undefined,
      delay: setTimeout(() => {
        s.timer = setInterval(() => {
          out.write(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${active}…`);
        }, 80);
      }, SPINNER_DELAY_MS),
    };
    spinner = s;
  };

  const line = (label: string, summary: string, ms: number) => {
    if (options.quiet) return;
    clearSpinner();
    const time = `${(ms / 1000).toFixed(1)}s`;
    const padded = summary.length >= 46 ? `${summary}  ` : summary.padEnd(48);
    out.write(`✓ ${label.padEnd(10)}${padded}${time}\n`);
  };

  const logger: Logger = {
    debug: (m) => {
      if (options.verbose && !options.quiet) out.write(`  ${m}\n`);
    },
    info: (m) => {
      if (!options.quiet) out.write(`  ${m}\n`);
    },
  };

  return {
    logger,
    stageStart: (stage: string) => {
      const active = ACTIVE[stage];
      if (active) startSpinner(active);
    },
    stage: (r: StageReport) => line(LABELS[r.stage] ?? r.stage, r.summary, r.ms),
    /** Runs `fn` as one stage; `active` is the spinner text while it runs (terminals only). */
    async time<T>(
      label: string,
      fn: () => Promise<T>,
      summarize: (v: T) => string,
      active?: string,
    ): Promise<T> {
      const start = performance.now();
      if (active) startSpinner(active);
      const value = await fn();
      line(label, summarize(value), performance.now() - start);
      return value;
    },
    /** Clears a running spinner before an error message. */
    fail: clearSpinner,
    warn: (m: string) => {
      if (!options.quiet) out.write(`! ${m}\n`);
    },
    note: (m: string) => {
      if (!options.quiet) out.write(`  ${m}\n`);
    },
    done: (m: string) => {
      if (!options.quiet) out.write(`→ ${m}\n`);
    },
  };
}
