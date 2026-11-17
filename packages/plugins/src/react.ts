/**
 * React plugin (M14): applies when a package.json depends on `react` (Preact through
 * `preact/compat` reads the same). Components, their JSX uses (`<Child>`), hooks and context
 * are ordinary references the graph stage already follows; what React adds is where files sit.
 *
 * - Layers: custom hooks (`use*` files, `hooks/` folders) → util, read before the components
 *   that call them; state stores (Redux Toolkit, Zustand, Jotai, Valtio, Recoil, MobX) and
 *   context modules (`createContext` outside a component file) → service.
 * - Hints: the props of an exported component changed while other code renders it.
 */

import type {
  FileChange,
  FileSources,
  FrameworkPlugin,
  HintDraft,
  HintInput,
  Layer,
} from '@bowi/core';
import {
  calls,
  Changes,
  importsFrom,
  SCRIPT_LANGUAGES,
  sourceOf,
  TEST_PATH,
  usesPackage,
} from './shared.ts';

const STORE_LIBRARIES =
  /^(@reduxjs\/toolkit|redux|zustand|jotai|valtio|recoil|mobx|@tanstack\/store)(\/|$)/;
const HOOK_FILE = /(^|\/)hooks?\/|(^|\/)use[A-Z][\w-]*\.[cm]?[jt]sx?$/;

/** Layers of React code, also used by the React frameworks (Next.js, React Router). */
export function reactLayer(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (!src) return undefined;
  if (importsFrom(src, STORE_LIBRARIES)) return 'service';
  if (HOOK_FILE.test(file.path)) return 'util';
  if (!/\.[jt]sx$/.test(file.path) && calls(src, ['createContext'])) return 'service';
  return undefined;
}

/**
 * An exported component whose first line (where its props are) changed, with outside uses:
 * the places that render it may need a look.
 */
export function propsHints(input: HintInput): HintDraft[] {
  const c = new Changes(input);
  const hints: HintDraft[] = [];
  for (const s of c.logic) {
    const file = c.fileById.get(s.fileId)!;
    if (!/\.[jt]sx$/.test(file.path) || !/^[A-Z]/.test(s.name) || s.change !== 'signature')
      continue;
    if (s.kind !== 'function' && s.kind !== 'variable') continue;
    const uses = input.outsideRefCounts.get(s.id) ?? 0;
    if (uses === 0) continue;
    hints.push({
      ruleId: 'component-props',
      severity: 'attention',
      message: `Props of \`<${s.name}>\` changed; ${uses} other place${uses === 1 ? '' : 's'} render${uses === 1 ? 's' : ''} it`,
      symbolId: s.id,
    });
  }
  return hints;
}

export const reactPlugin: FrameworkPlugin = {
  id: 'react',
  detect: (repo) => usesPackage(repo, ['react', 'preact']),
  layerOf: reactLayer,
  hints: propsHints,
};
