import { describe, expect, it } from 'vitest';
import { codeOnly } from '../src/index.ts';

describe('codeOnly', () => {
  it('blanks comments and string contents but keeps template code and line breaks', () => {
    const src = [
      'const a = ky.create(); // ky.create() here',
      '/**',
      'In contrast to `ky.create()`',
      '*/',
      "test('works with ky.create()', () => {});",
      'const t = `x ${ky.create({ a: { b: 1 } })} y`;',
      "const s = 'it\\'s ky.create()';",
    ].join('\n');
    const lines = codeOnly(src).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines.map((l) => l.includes('ky.create('))).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(lines[4]).toBe("test('                      ', () => {});");
  });
});
