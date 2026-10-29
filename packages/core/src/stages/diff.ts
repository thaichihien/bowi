/**
 * Stage 2: diff → files and hunks (DIFF-1..3).
 *
 * Input: a Snapshot. Output: FileChange[] sorted by path with IDs `f<n>`, and Hunk[] in file
 * order with IDs `f<n>:h<m>`. IDs depend only on the diff, so they are stable across runs.
 *
 * Analysis fields filled by later stages start neutral here: layer `unknown`, parseStatus
 * `unsupported`, generated false, hunk kind `logic`, no symbols.
 */

import { compareStrings } from '../determinism.ts';
import { parseUnifiedDiff, type ParsedFile } from '../diff/parse-unified.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Stage } from '../stage.ts';
import type { FileChange, Hunk } from '../types.ts';

export interface DiffStageOutput {
  files: FileChange[];
  hunks: Hunk[];
}

export const diffStage: Stage<Snapshot, DiffStageOutput> = async (snapshot) => {
  const parsed = parseUnifiedDiff(await snapshot.readDiff());
  const sorted = [...parsed].sort((a, b) => compareStrings(pathOf(a), pathOf(b)));

  const files: FileChange[] = [];
  const hunks: Hunk[] = [];
  sorted.forEach((p, fileIndex) => {
    const fileId = `f${fileIndex}`;
    let additions = 0;
    let deletions = 0;
    p.hunks.forEach((h, hunkIndex) => {
      for (const line of h.lines) {
        if (line.kind === 'add') additions++;
        else if (line.kind === 'del') deletions++;
      }
      hunks.push({
        id: `${fileId}:h${hunkIndex}`,
        fileId,
        header: h.section.trim(),
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
        kind: 'logic',
        symbolIds: [],
      });
    });

    const file: FileChange = {
      id: fileId,
      path: pathOf(p),
      status: statusOf(p),
      parseStatus: 'unsupported',
      layer: 'unknown',
      additions,
      deletions,
      generated: false,
    };
    if (p.oldPath !== null && p.oldPath !== p.newPath && p.newPath !== null)
      file.oldPath = p.oldPath;
    files.push(file);
  });
  return { files, hunks };
};

function pathOf(p: ParsedFile): string {
  return p.newPath ?? p.oldPath ?? '';
}

function statusOf(p: ParsedFile): FileChange['status'] {
  if (p.binary) return 'binary';
  if (p.kind !== 'modified') return p.kind;
  if (p.hunks.length === 0 && p.oldMode !== p.newMode) return 'mode';
  return 'modified';
}
