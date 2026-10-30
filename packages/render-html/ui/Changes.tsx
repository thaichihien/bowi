/**
 * Changes tab: every file in GitHub's order (subfolders before files at each level) with a file
 * tree and filter, like GitHub's "Files changed" without review features. Unified (default) or
 * split layout, remembered per viewer. As on GitHub, generated, deleted and large files start
 * closed behind "Load diff"; files without a text diff say why.
 */

import type { FileChange } from '@bowi/core/types';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { CopyButton } from './Copy.tsx';
import { DiffBlocks, hunkBarText, SplitLines, UnifiedLines } from './Diff.tsx';
import { Chevron, FileStatusIcon, FolderIcon } from './Icons.tsx';
import {
  baseName,
  changedLines,
  formatCount,
  githubOrder,
  LARGE_FILE_LINES,
  type Model,
} from './model.ts';

type Layout = 'unified' | 'split';
const LAYOUT_KEY = 'bowi:diff-layout';
/** Below this width the split layout does not fit; unified is shown instead. */
const NARROW = '(max-width: 900px)';

export function ChangesTab({ model }: { model: Model }) {
  const files = useMemo(() => githubOrder(model.plan.files), [model]);
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const narrow = useMedia(NARROW);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Storage can be unavailable (private window, file:// restrictions): keep it in memory.
    }
  };
  const query = filter.trim().toLowerCase();
  const shown = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
  const isOpen = (f: FileChange) => open[f.id] ?? closedReason(model, f) === undefined;
  const anyOpen = shown.some(isOpen);
  const split = layout === 'split' && !narrow;

  return (
    <div class="wrap tab-page">
      <div class="changes">
        <nav class="card tree" aria-label="Changed files">
          <label class="visually-hidden" for="file-filter">
            Filter changed files
          </label>
          <input
            id="file-filter"
            type="search"
            placeholder="Filter files…"
            value={filter}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          />
          <TreeView dir={buildTree(shown)} depth={0} />
          {shown.length === 0 && <p class="muted small tree-empty">No file matches.</p>}
        </nav>
        <main class="diffs">
          <div class="toolbar">
            <span>
              <strong>{formatCount(files.length)}</strong> file{files.length === 1 ? '' : 's'}{' '}
              changed
            </span>
            <div class="toolbar-group">
              {narrow && layout === 'split' && (
                <span class="muted small">Split needs a wider window</span>
              )}
              <div role="group" aria-label="Diff layout" class="segs">
                <button
                  class={layout === 'unified' ? 'seg on' : 'seg'}
                  aria-pressed={layout === 'unified'}
                  onClick={() => setLayout('unified')}
                >
                  Unified
                </button>
                <button
                  class={layout === 'split' ? 'seg on' : 'seg'}
                  aria-pressed={layout === 'split'}
                  onClick={() => setLayout('split')}
                >
                  Split
                </button>
              </div>
              <button
                class="btn small"
                onClick={() =>
                  setOpen(Object.fromEntries(shown.map((f) => [f.id, !anyOpen] as const)))
                }
              >
                {anyOpen ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          </div>
          {shown.map((f) => (
            <FileDiff
              key={f.id}
              model={model}
              file={f}
              open={isOpen(f)}
              userSet={f.id in open}
              split={split}
              toggle={() => setOpen({ ...open, [f.id]: !isOpen(f) })}
            />
          ))}
        </main>
      </div>
    </div>
  );
}

/** Why a file starts closed, as GitHub words it; undefined when it starts open. */
function closedReason(model: Model, file: FileChange): string | undefined {
  if (file.generated) return 'Generated files are not rendered by default.';
  if (file.status === 'deleted') return 'This file was deleted.';
  if (changedLines(model.hunksOfFile(file.id)) > LARGE_FILE_LINES)
    return 'Large diffs are not rendered by default.';
  return undefined;
}

/** For files without a text diff. */
function noDiffNote(file: FileChange): string {
  if (file.status === 'binary') return 'Binary file not shown.';
  if (file.status === 'renamed') return 'File renamed without changes.';
  if (file.status === 'copied') return 'File copied without changes.';
  if (file.status === 'mode') return 'File mode changed.';
  return 'No changes to show.';
}

const STATUS_BADGES: Partial<Record<FileChange['status'], string>> = {
  added: 'New file',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  binary: 'Binary',
  mode: 'Mode changed',
};

function FileDiff(props: {
  model: Model;
  file: FileChange;
  open: boolean;
  userSet: boolean;
  split: boolean;
  toggle: () => void;
}) {
  const { model, file, open } = props;
  const hunks = model.hunksOfFile(file.id);
  const reason = closedReason(model, file);
  const badge = STATUS_BADGES[file.status];
  return (
    <section class="gh-file" id={`file-${file.id}`} aria-label={file.path}>
      <div class="gh-file-head">
        <button
          class="icon-btn"
          aria-expanded={open}
          aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
          onClick={props.toggle}
        >
          <Chevron open={open} />
        </button>
        <span class="mono gh-path">
          {file.oldPath && file.oldPath !== file.path
            ? `${file.oldPath} → ${file.path}`
            : file.path}
        </span>
        <CopyButton text={file.path} label="Copy file path" />
        {badge && <span class={`badge badge-${file.status}`}>{badge}</span>}
        <span class="grow" />
        <span class="mono delta-line">
          <span class="plus">+{formatCount(file.additions)}</span>
          <span class="minus">−{formatCount(file.deletions)}</span>
          <DiffBlocks additions={file.additions} deletions={file.deletions} />
        </span>
      </div>
      {hunks.length === 0 ? (
        <p class="gh-note">{noDiffNote(file)}</p>
      ) : open ? (
        <div class="hunks">
          {hunks.map((h) => (
            <div key={h.id}>
              <div class={props.split ? 'mono hunk-bar gh split' : 'mono hunk-bar gh'}>
                {hunkBarText(h)}
              </div>
              {props.split ? <SplitLines hunk={h} /> : <UnifiedLines hunk={h} />}
            </div>
          ))}
        </div>
      ) : (
        !props.userSet &&
        reason && (
          <div class="gh-note">
            <span>{reason}</span>
            <button class="link-btn" onClick={props.toggle}>
              Load diff
            </button>
          </div>
        )
      )}
    </section>
  );
}

interface Dir {
  name: string;
  dirs: Dir[];
  files: FileChange[];
}

/** Folders from the (already ordered) files; single-child folder chains are joined: `src/auth`. */
export function buildTree(files: FileChange[]): Dir {
  const root: Dir = { name: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const name of parts.slice(0, -1)) {
      let next = dir.dirs.find((d) => d.name === name);
      if (!next) {
        next = { name, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  const compact = (d: Dir): Dir => {
    let out = { ...d, dirs: d.dirs.map(compact) };
    while (out.name && out.files.length === 0 && out.dirs.length === 1) {
      const only = out.dirs[0]!;
      out = { name: `${out.name}/${only.name}`, dirs: only.dirs, files: only.files };
    }
    return out;
  };
  return compact(root);
}

function TreeView({ dir, depth }: { dir: Dir; depth: number }) {
  const indent = { paddingLeft: `${8 + depth * 14}px` };
  return (
    <>
      {dir.dirs.map((d) => (
        <div key={`d:${d.name}`}>
          <div class="tr dir" style={indent}>
            <FolderIcon />
            <span>{d.name}</span>
          </div>
          <TreeView dir={d} depth={depth + 1} />
        </div>
      ))}
      {dir.files.map((f) => (
        <button
          key={f.id}
          class="tr"
          style={indent}
          title={f.path}
          onClick={() =>
            document.getElementById(`file-${f.id}`)?.scrollIntoView({ block: 'start' })
          }
        >
          <FileStatusIcon status={f.status} />
          <span>{baseName(f.path)}</span>
        </button>
      ))}
    </>
  );
}

function loadLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

function useMedia(query: string): boolean {
  const matches = () => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [value, setValue] = useState(matches);
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => setValue(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return value;
}
