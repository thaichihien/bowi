/**
 * Dev tool: prints a review-plan.json in readable form (until the HTML report exists).
 *
 * Usage:
 *   node scripts/show-plan.ts [plan.json | folder]        overview: files, hunks, symbols
 *   node scripts/show-plan.ts [plan.json | folder] <hunk>  one hunk's lines, e.g. f9:h0
 *
 * A folder is searched for review-plan.json, including under .bowi/. Default: current folder.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewPlan } from '@bowi/core';

const args = process.argv.slice(2);
const hunkArg = args.find((a) => /^f\d+:h\d+$/.test(a));
const target = args.find((a) => a !== hunkArg) ?? '.';
const plan: ReviewPlan = JSON.parse(readFileSync(findPlan(target), 'utf8'));
const fileById = new Map(plan.files.map((f) => [f.id, f]));
const symbolById = new Map(plan.symbols.map((s) => [s.id, s]));

if (hunkArg) showHunk(hunkArg);
else overview();

function overview() {
  const s = plan.source;
  console.log(
    `${s.repo}: ${s.headRef} vs ${s.baseRef} (merge base ${s.mergeBaseSha.slice(0, 7)}, ${s.commits.length} commits)`,
  );
  const st = plan.stats;
  console.log(
    `${st.files} files, ${st.hunks} hunks, +${st.additions} −${st.deletions} · ` +
      `${st.reviewLines} lines to review, ${st.noiseLines} noise · languages: ${plan.meta.languages.join(', ') || '—'}`,
  );
  for (const w of plan.meta.warnings) console.log(`! ${w}`);

  section('Files');
  for (const f of plan.files) {
    const flags = [f.generated ? 'generated' : '', f.parseStatus !== 'ok' ? f.parseStatus : '']
      .filter(Boolean)
      .join(', ');
    console.log(
      `  ${f.id.padEnd(4)} ${f.status.padEnd(8)} ${f.layer.padEnd(8)} ${`+${f.additions} −${f.deletions}`.padEnd(10)} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}${flags ? `  [${flags}]` : ''}`,
    );
  }

  section('Hunks');
  for (const h of plan.hunks) {
    const path = fileById.get(h.fileId)!.path;
    const extra =
      h.kind === 'move' && h.move
        ? `  ↔ ${h.move.pairHunkId}, similarity ${h.move.similarity}, ${h.move.changedLineIndexes.length} changed line(s)`
        : '';
    console.log(
      `  ${h.id.padEnd(7)} ${h.kind.padEnd(9)} ${path}${h.header ? ` · ${h.header}` : ''}${extra}`,
    );
  }

  section('Changed symbols');
  for (const sym of plan.symbols) {
    const sig =
      sym.change === 'signature'
        ? `\n${' '.repeat(22)}${sym.oldSignature}\n${' '.repeat(20)}→ ${sym.newSignature}`
        : '';
    console.log(
      `  ${sym.change.padEnd(9)} ${sym.kind.padEnd(9)} ${sym.qualifiedName}  (${sym.hunkIds.join(', ')})${sig}`,
    );
  }
  console.log(`\nShow one hunk: show-plan ${plan.hunks[0]?.id ?? 'f0:h0'}`);
}

function showHunk(id: string) {
  const h = plan.hunks.find((x) => x.id === id);
  if (!h) throw new Error(`No hunk ${id}`);
  const file = fileById.get(h.fileId)!;
  console.log(
    `${h.id} · ${h.kind} · ${file.path} · @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.header}`,
  );
  if (h.symbolIds.length)
    console.log(
      `symbols: ${h.symbolIds.map((s) => symbolById.get(s)?.qualifiedName ?? s).join(', ')}`,
    );
  if (h.move) {
    console.log(
      `move: from ${fileById.get(h.move.fromFileId)!.path}:${h.move.fromStart}, other half ${h.move.pairHunkId}, similarity ${h.move.similarity}`,
    );
    console.log('      lines marked » differ between the two halves');
  }
  console.log();
  const changed = new Set(h.move?.changedLineIndexes ?? []);
  h.lines.forEach((l, i) => {
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    const mark = changed.has(i) ? '»' : ' ';
    console.log(
      `${String(l.oldNo ?? '').padStart(4)} ${String(l.newNo ?? '').padStart(4)} ${mark}${sign} ${l.text}${l.noEol ? '  ⏎̸ (no newline)' : ''}`,
    );
  });
}

function section(title: string) {
  console.log(`\n${title}`);
}

function findPlan(path: string): string {
  if (statSync(path).isFile()) return path;
  if (existsSync(join(path, 'review-plan.json'))) return join(path, 'review-plan.json');
  const bowi = join(path, '.bowi');
  if (existsSync(bowi)) {
    const dirs = readdirSync(bowi)
      .map((d) => join(bowi, d))
      .filter((d) => existsSync(join(d, 'review-plan.json')))
      .sort(
        (a, b) =>
          statSync(join(b, 'review-plan.json')).mtimeMs -
          statSync(join(a, 'review-plan.json')).mtimeMs,
      );
    if (dirs[0]) return join(dirs[0], 'review-plan.json');
  }
  throw new Error(`No review-plan.json in ${path} or its .bowi/ folder`);
}
