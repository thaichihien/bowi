/**
 * Stage 3: read and parse both versions of every changed text file (PARSE-1..4, NOISE-1).
 *
 * Input: snapshot and files from stage 2. Output: files with `language`, `parseStatus` and
 * `generated` filled in, plus the parsed sources by file ID. Generated files are not parsed.
 * A file whose grammar reports syntax errors on either side, or that is too large, falls back to
 * text-only analysis (tier 0) with a warning; the run continues (NFR-5).
 *
 * The caller owns the returned sources and must call disposeSources() when done.
 */

import { languageForPath, parseSource, type ParsedSource } from '@bowi/lang';
import { createGeneratedMatcher, hasGeneratedHeader } from '../noise/generated.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Stage } from '../stage.ts';
import type { FileChange } from '../types.ts';
import { mapLimit } from '../util/concurrency.ts';

/** Larger file versions are not parsed (tree-sitter memory and time); they use tier 0. */
export const MAX_PARSE_BYTES = 1_000_000;

export interface FileSources {
  old?: ParsedSource;
  new?: ParsedSource;
}

export interface ParseStageInput {
  snapshot: Snapshot;
  files: FileChange[];
}

export interface ParseStageOutput {
  files: FileChange[];
  /** Only files parsed successfully on every side they exist on. */
  sources: Map<string, FileSources>;
  /** Why each generated file is generated, by file ID. */
  generatedReasons: Map<string, string>;
  /** Number of file versions parsed. */
  parsedVersions: number;
}

export const parseStage: Stage<ParseStageInput, ParseStageOutput> = async (
  { snapshot, files },
  ctx,
) => {
  const generated = createGeneratedMatcher(
    ctx.config.generated,
    await snapshot.readFile('new', '.gitattributes'),
  );
  const sources = new Map<string, FileSources>();
  const generatedReasons = new Map<string, string>();
  let parsedVersions = 0;

  const texts = await mapLimit(files, 8, async (f) => {
    if (f.status === 'binary') return { old: null, new: null };
    const hasOld = f.status !== 'added';
    const hasNew = f.status !== 'deleted';
    return {
      old: hasOld ? await snapshot.readFile('old', f.oldPath ?? f.path) : null,
      new: hasNew ? await snapshot.readFile('new', f.path) : null,
    };
  });

  const out: FileChange[] = [];
  // Parsing is sequential: tree-sitter runs on one WebAssembly thread anyway.
  for (const [i, file] of files.entries()) {
    const text = texts[i]!;
    const next: FileChange = { ...file };
    const language = languageForPath(file.path);
    if (language) next.language = language;

    const reason =
      generated.byPath(file.path) ??
      (hasGeneratedHeader(text.new ?? text.old ?? '')
        ? 'generator marker in the file header'
        : null);
    if (reason) {
      next.generated = true;
      generatedReasons.set(file.id, reason);
    }

    if (!language || next.generated || file.status === 'binary') {
      out.push(next);
      continue;
    }

    const versions = [text.old, text.new].filter((t): t is string => t !== null);
    if (versions.some((t) => Buffer.byteLength(t) > MAX_PARSE_BYTES)) {
      next.parseStatus = 'unsupported';
      ctx.warn(
        `${file.path} is larger than ${MAX_PARSE_BYTES / 1_000_000} MB; used text-only analysis`,
      );
      out.push(next);
      continue;
    }

    try {
      const parsed: FileSources = {};
      if (text.old !== null) parsed.old = await parseSource(language, text.old);
      if (text.new !== null) parsed.new = await parseSource(language, text.new);
      parsedVersions += versions.length;
      if (parsed.old?.hasError || parsed.new?.hasError) {
        disposeFileSources(parsed);
        next.parseStatus = 'error';
        ctx.warn(`${file.path} has syntax errors; used text-only analysis`);
      } else {
        next.parseStatus = 'ok';
        sources.set(file.id, parsed);
      }
    } catch (e) {
      next.parseStatus = 'error';
      ctx.warn(
        `${file.path} failed to parse (${e instanceof Error ? e.message : String(e)}); used text-only analysis`,
      );
    }
    out.push(next);
  }

  return { files: out, sources, generatedReasons, parsedVersions };
};

function disposeFileSources(s: FileSources): void {
  s.old?.dispose();
  s.new?.dispose();
}

export function disposeSources(sources: Map<string, FileSources>): void {
  for (const s of sources.values()) disposeFileSources(s);
  sources.clear();
}
