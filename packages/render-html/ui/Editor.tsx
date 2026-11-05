/**
 * The comment editor (UI-26), as on GitHub: Write and Preview tabs, and a toolbar whose buttons
 * write Markdown around the selection (Bold, Italic, Quote, Code, Link, lists). ⌘B / Ctrl+B,
 * ⌘I, ⌘K format; ⌘Enter submits and Escape cancels when the editor has those actions.
 */

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { commentHtml } from './markdown.ts';

type Tool = 'bold' | 'italic' | 'quote' | 'code' | 'link' | 'ul' | 'ol';

const TOOLS: { id: Tool; label: string; d: string; gap?: boolean }[] = [
  { id: 'bold', label: 'Bold (⌘B)', d: 'M4.5 2.75h4.25a2.6 2.6 0 0 1 0 5.2H4.5zM4.5 7.95h4.9a2.65 2.65 0 0 1 0 5.3H4.5z' },
  { id: 'italic', label: 'Italic (⌘I)', d: 'M10.5 2.75H6.75M9.25 13.25H5.5M8.6 2.75l-1.2 10.5' },
  { id: 'quote', label: 'Quote', d: 'M3 3.5v9M6 4.5h7.5M6 8h7.5M6 11.5h5', gap: true },
  { id: 'code', label: 'Code', d: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5' },
  { id: 'link', label: 'Link (⌘K)', d: 'M6.75 9.25a2.5 2.5 0 0 0 3.55 0l2.2-2.2a2.5 2.5 0 0 0-3.55-3.55l-.7.7M9.25 6.75a2.5 2.5 0 0 0-3.55 0l-2.2 2.2a2.5 2.5 0 0 0 3.55 3.55l.7-.7' },
  { id: 'ul', label: 'Bulleted list', d: 'M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2.75 4h.01M2.75 8h.01M2.75 12h.01', gap: true },
  { id: 'ol', label: 'Numbered list', d: 'M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2 3l1.25-.75v3.25M2 9.25h1.9L2 11.75h2' },
]; // prettier-ignore

/** The text after a toolbar action, with the selection to put back. */
export function applyTool(
  tool: Tool,
  value: string,
  start: number,
  end: number,
): { value: string; start: number; end: number } {
  const sel = value.slice(start, end);
  const wrap = (m: string) =>
    sel
      ? { value: value.slice(0, start) + m + sel + m + value.slice(end), start: start + m.length, end: end + m.length } // prettier-ignore
      : { value: value.slice(0, start) + m + m + value.slice(end), start: start + m.length, end: start + m.length }; // prettier-ignore
  if (tool === 'bold') return wrap('**');
  if (tool === 'italic') return wrap('_');
  if (tool === 'code') return wrap('`');
  if (tool === 'link') {
    // "[text](url)" with "url" selected, ready to paste over.
    const text = `[${sel}](url)`;
    const at = sel ? start + sel.length + 3 : start + 1;
    return {
      value: value.slice(0, start) + text + value.slice(end),
      start: at,
      end: sel ? at + 3 : at,
    };
  }
  // Line tools prefix every line the selection touches.
  const from = value.lastIndexOf('\n', start - 1) + 1;
  let to = value.indexOf('\n', end);
  if (to < 0) to = value.length;
  const lines = value
    .slice(from, to)
    .split('\n')
    .map((l, i) => (tool === 'quote' ? '> ' : tool === 'ul' ? '- ' : `${i + 1}. `) + l)
    .join('\n');
  const at = from + lines.length;
  return { value: value.slice(0, from) + lines + value.slice(to), start: at, end: at };
}

export function MarkdownEditor(props: {
  value: string;
  onInput: (value: string) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onCancel?: () => void;
  /** Left side of the footer; buttons go in `children`, on the right. */
  note?: ComponentChildren;
  children?: ComponentChildren;
  class?: string;
}) {
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<[number, number]>();
  useEffect(() => {
    if (props.autoFocus) area.current?.focus();
  }, [props.autoFocus]);
  // Puts the selection back once the new text is on the page.
  useEffect(() => {
    const s = pendingSelection.current;
    if (!s || !area.current) return;
    pendingSelection.current = undefined;
    area.current.focus();
    area.current.setSelectionRange(s[0], s[1]);
  });

  const run = (tool: Tool) => {
    const el = area.current;
    const start = el?.selectionStart ?? props.value.length;
    const end = el?.selectionEnd ?? props.value.length;
    const r = applyTool(tool, props.value, start, end);
    pendingSelection.current = [r.start, r.end];
    props.onInput(r.value);
  };

  return (
    <div class={props.class ? `editor ${props.class}` : 'editor'}>
      <div class="editor-head">
        <div class="editor-tabs" role="tablist" aria-label="Comment">
          <button
            role="tab"
            class={preview ? 'editor-tab' : 'editor-tab on'}
            aria-selected={!preview}
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            role="tab"
            class={preview ? 'editor-tab on' : 'editor-tab'}
            aria-selected={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>
        {!preview && (
          <div class="editor-tools" role="toolbar" aria-label="Formatting">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                class={t.gap ? 'tool gap' : 'tool'}
                aria-label={t.label}
                title={t.label}
                // Keeps the textarea's selection while the button is pressed.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(t.id)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d={t.d} />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>
      {preview ? (
        <div class="editor-preview">
          {props.value.trim() ? (
            <Markdown text={props.value} />
          ) : (
            <span class="muted">Nothing to preview</span>
          )}
        </div>
      ) : (
        <textarea
          ref={area}
          aria-label={props.label}
          placeholder={props.placeholder}
          value={props.value}
          onInput={(e) => props.onInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            const k = e.key.toLowerCase();
            if (mod && (k === 'b' || k === 'i' || k === 'k')) {
              e.preventDefault();
              run(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'link');
            } else if (mod && e.key === 'Enter' && props.onSubmit) {
              e.preventDefault();
              props.onSubmit();
            } else if (e.key === 'Escape' && props.onCancel) {
              e.preventDefault();
              props.onCancel();
            }
          }}
        />
      )}
      <div class="editor-foot">
        <span class="muted small">{props.note ?? 'Markdown is supported'}</span>
        {props.children && <span class="editor-actions">{props.children}</span>}
      </div>
    </div>
  );
}

/** Comment text rendered from Markdown (markdown.ts: raw HTML off, images as links). */
export function Markdown({ text }: { text: string }) {
  return <div class="md comment-md" dangerouslySetInnerHTML={{ __html: commentHtml(text) }} />;
}
