/**
 * Diff rendering: file cards with hunks (UI-5) and the moved-code view (UI-6).
 * Line text is rendered as text; only `DiffLine.html` (escaped at build time) is markup.
 */

import type { DiffLine, FileChange, Hunk } from '@bowi/core/types';
import { useState } from 'preact/hooks';
import { changeLabel, fileTag, type Model } from './model.ts';

type LineClass = 'c' | 'a' | 'd' | 'm' | 'x' | 'w';

export function FileCard({
  model,
  file,
  hunks,
  tag,
}: {
  model: Model;
  file: FileChange;
  hunks: Hunk[];
  tag?: string;
}) {
  const symbols = [...new Set(hunks.flatMap((h) => h.symbolIds))]
    .map((id) => model.symbols.get(id)!)
    .filter(Boolean);
  const named = symbols.filter((s) => s.kind !== 'file');
  const adds = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0);
  const dels = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0);
  const label = tag ?? fileTag(file, symbols);
  return (
    <div class="card file">
      <div class="file-head">
        <div class="file-name">
          <span class="mono path">{file.path}</span>
          {named.length > 0 && (
            <span class="mono sym">
              {named
                .slice(0, 2)
                .map((s) => s.qualifiedName)
                .join(', ')}
              {named.length > 2 ? ` +${named.length - 2}` : ''}
            </span>
          )}
          {label && <span class="chip k-move">{label}</span>}
        </div>
        <span class="mono delta">
          <span class="plus">+{adds}</span> <span class="minus">−{dels}</span>
        </span>
      </div>
      <div class="hunks">
        {hunks.map((h) => (
          <HunkView
            key={h.id}
            model={model}
            hunk={h}
            wholeFile={file.status === 'added' || file.status === 'deleted'}
          />
        ))}
      </div>
    </div>
  );
}

function HunkView({ model, hunk, wholeFile }: { model: Model; hunk: Hunk; wholeFile: boolean }) {
  // The header already names the hunk's first symbol; other symbols are named with their change.
  // A new or deleted file says so in its file tag, so its symbols need no tags.
  const tags = (wholeFile ? [] : hunk.symbolIds)
    .map((id, i) => ({ s: model.symbols.get(id), first: i === 0 }))
    .filter(({ s }) => s && s.kind !== 'file' && s.change !== 'body')
    .map(({ s, first }) => (first ? changeLabel(s!) : `${s!.name} · ${changeLabel(s!)}`));
  return (
    <div id={`hunk-${hunk.id}`}>
      <div class="mono hunk-bar">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.header}
        {tags.length > 0 && <span class="hunk-tags"> · {tags.join(' · ')}</span>}
      </div>
      <div class="lines">
        {hunk.lines.map((l, i) => (
          <Line key={i} line={l} cls={l.kind === 'add' ? 'a' : l.kind === 'del' ? 'd' : 'c'} />
        ))}
      </div>
    </div>
  );
}

function Line({ line, cls, sign }: { line: DiffLine; cls: LineClass; sign?: string }) {
  const mark = sign ?? (line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ');
  return (
    <div class={`ln l-${cls}`}>
      <span class="no">{line.oldNo ?? ''}</span>
      <span class="no">{line.newNo ?? ''}</span>
      <span class="sign">{mark}</span>
      {line.html !== undefined ? (
        <span class="code" dangerouslySetInnerHTML={{ __html: line.html || ' ' }} />
      ) : (
        <span class="code">{line.text || ' '}</span>
      )}
      {line.noEol && (
        <span class="noeol" title="No newline at end of file">
          ⏎̸
        </span>
      )}
    </div>
  );
}

/**
 * The destination of a move with unchanged lines muted, lines changed during the move
 * highlighted, and the original version of each changed line struck through above it.
 */
export function MovedView({ model, to, from }: { model: Model; to: Hunk; from: Hunk }) {
  const [showOrigin, setShowOrigin] = useState(false);
  const toFile = model.files.get(to.fileId)!;
  const fromFile = model.files.get(from.fileId)!;
  const changedTo = new Set(to.move?.changedLineIndexes ?? []);
  const originals = (from.move?.changedLineIndexes ?? []).map((i) => from.lines[i]!);
  const rows: { line: DiffLine; cls: LineClass; sign: string }[] = [];
  let k = 0;
  to.lines.forEach((l, i) => {
    if (l.kind === 'context') rows.push({ line: l, cls: 'c', sign: ' ' });
    else if (changedTo.has(i)) {
      if (k < originals.length) rows.push({ line: originals[k++]!, cls: 'w', sign: '−' });
      rows.push({ line: l, cls: 'x', sign: '~' });
    } else rows.push({ line: l, cls: 'm', sign: ' ' });
  });
  while (k < originals.length) rows.push({ line: originals[k++]!, cls: 'w', sign: '−' });
  const fromLine = to.move?.fromStart ?? from.oldStart;

  return (
    <>
      <div class="card file">
        <div class="file-head">
          <div class="file-name">
            <span class="mono path">{toFile.path}</span>
            <span class="chip k-move">Moved from {fromFile.path}</span>
          </div>
          <span class="mono delta">similarity {Math.round((to.move?.similarity ?? 1) * 100)}%</span>
        </div>
        <div class="hunks">
          <div class="mono hunk-bar">
            moved from {fromFile.path}:{fromLine} · {to.header}
          </div>
          <div class="lines">
            {rows.map((r, i) => (
              <Line key={i} line={r.line} cls={r.cls} sign={r.sign} />
            ))}
          </div>
        </div>
      </div>
      <div class="legend">
        <span>
          <span class="swatch l-m" />
          Moved, unchanged
        </span>
        <span>
          <span class="swatch l-x" />
          Changed during the move
        </span>
        <span>
          <span class="swatch l-w" />
          Original line in {fromFile.path}
        </span>
        <button class="btn small" onClick={() => setShowOrigin(!showOrigin)}>
          {showOrigin ? 'Hide' : 'Show'} the removed code in {fromFile.path}
        </button>
      </div>
      {showOrigin && <FileCard model={model} file={fromFile} hunks={[from]} tag="Moved away" />}
    </>
  );
}
