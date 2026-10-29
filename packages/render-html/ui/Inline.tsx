/** Text with `backtick` spans rendered as code. Everything is text; nothing is parsed as HTML. */
export function Inline({ text }: { text: string }) {
  const parts = text.split('`');
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : p))}</>;
}
