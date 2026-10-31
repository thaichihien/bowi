/**
 * Extension points (PLG-1, HINT-1): framework plugins and review hint rules.
 *
 * Both are passed to `analyze()` by the caller (the CLI), so the engine does not depend on the
 * packages that implement them (`@bowi/plugins`, `@bowi/rules`). Like stages, they are pure:
 * everything they need is in their input, and they must return the same output for the same
 * input (GRP-12).
 */

import type { FileVersion } from './snapshot.ts';
import type { FileSources } from './stages/parse.ts';
import type {
  ChangedSymbol,
  ChangeEdge,
  FileChange,
  Group,
  Hunk,
  Layer,
  OutsideReference,
  ReviewHint,
} from './types.ts';

/** What a plugin sees when deciding whether it applies to the repository. */
export interface PluginRepo {
  files: FileChange[];
  readFile(version: FileVersion, path: string): Promise<string | null>;
}

/** The analysis so far: files with layers, hunks with symbols, parsed sources, line owners. */
export interface PluginGraphInput {
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  sources: Map<string, FileSources>;
  /** For each hunk, the symbol ID owning each line (by index into `lines`); null if none. */
  lineSymbols: Map<string, (string | null)[]>;
}

/** A `framework` edge (GRAPH-9): `from` depends on `to`, so `to` is read first. */
export interface PluginEdge {
  from: string;
  to: string;
  text: string;
  locations: { fileId: string; line: number }[];
}

export interface HintDraft {
  ruleId: string;
  severity: ReviewHint['severity'];
  message: string;
  /** The most specific place the hint is about; the engine adds its step and group. */
  hunkId?: string;
  symbolId?: string;
  fileId?: string;
}

export interface NewDependency {
  name: string;
  dev: boolean;
}

export interface HintInput extends PluginGraphInput {
  edges: ChangeEdge[];
  groups: Group[];
  outsideRefs: OutsideReference[];
  /** Unchanged references found per symbol ID, before the per-symbol limit. */
  outsideRefCounts: Map<string, number>;
  /** Direct dependencies a file adds (package.json, or a lockfile's root entry), by file ID. */
  newDependencies: Map<string, NewDependency[]>;
}

export interface FrameworkPlugin {
  /** Short name listed in `meta.plugins`, e.g. `nestjs`. */
  id: string;
  /** Whether the repository uses the framework, e.g. `@nestjs/core` in a package.json. */
  detect(repo: PluginRepo): Promise<boolean>;
  /** A file's layer from its code; undefined leaves it to the path heuristics (SYM-4). */
  layerOf?(file: FileChange, sources: FileSources | undefined): Layer | undefined;
  extraEdges?(input: PluginGraphInput): PluginEdge[];
  hints?(input: HintInput): HintDraft[];
}

/** A review hint rule (HINT-2): informational labels, never pass/fail. */
export interface HintRule {
  id: string;
  run(input: HintInput): HintDraft[];
}
