/**
 * Embeds the plan in the page (UI-15). The JSON goes into a `<script type="application/json">`;
 * escaping `<`, `>`, `&` and the JavaScript line separators means repository content such as
 * `</script>` or `<!--` can never end the element or change how the page parses.
 */

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}
