/**
 * File names that fit (M20): a long name is cut in the middle, so its start and its extension
 * stay visible ("1730_add_e…rified.ts"), with the full name on hover. In a path the folder is cut
 * first, the file name only when the folder is gone. The cut is CSS: the start shrinks with an
 * ellipsis, the end never does, so a name is only cut when it does not fit.
 */

import { midSplit } from './model.ts';

export function MidName({ text, class: cls }: { text: string; class?: string }) {
  const { a, b } = midSplit(text);
  return (
    <span class={cls ? `mid ${cls}` : 'mid'} title={text}>
      {a && <span class="ma">{a}</span>}
      <span class="mb">{b}</span>
    </span>
  );
}

/** A path on one line: the folder muted, the file name bold. */
export function PathName({ path, class: cls }: { path: string; class?: string }) {
  const slash = path.lastIndexOf('/') + 1;
  return (
    <span class={cls ? `mono path ${cls}` : 'mono path'} title={path}>
      {slash > 0 && <span class="path-dir">{path.slice(0, slash)}</span>}
      <MidName text={path.slice(slash)} class="path-name" />
    </span>
  );
}
