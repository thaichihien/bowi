/**
 * Step-by-step progress output on stderr (CLI-6, format from §11.2).
 *
 * Plain lines, one per finished stage, with timing. `--quiet` prints nothing, `--verbose` adds
 * debug lines. The full listr-style display arrives in M5.
 */

import { performance } from 'node:perf_hooks';
import type { Logger, StageReport } from '@bowi/core';
import type { Writable } from './index.ts';

const LABELS: Record<string, string> = {
  diff: 'Diff',
  parse: 'Parsed',
  noise: 'Noise',
  symbols: 'Symbols',
};

export function createProgress(out: Writable, options: { quiet: boolean; verbose: boolean }) {
  const line = (label: string, summary: string, ms: number) => {
    if (options.quiet) return;
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
    stage: (r: StageReport) => line(LABELS[r.stage] ?? r.stage, r.summary, r.ms),
    async time<T>(label: string, fn: () => Promise<T>, summarize: (v: T) => string): Promise<T> {
      const start = performance.now();
      const value = await fn();
      line(label, summarize(value), performance.now() - start);
      return value;
    },
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
