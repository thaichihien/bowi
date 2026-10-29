import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, unquote } from '../src/diff/parse-unified.ts';

const diff = (...lines: string[]) => lines.join('\n') + '\n';

describe('parseUnifiedDiff', () => {
  it('parses a modified file with line numbers on both sides', () => {
    const [file] = parseUnifiedDiff(
      diff(
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -10,4 +10,5 @@ export class A {',
        '   one() {',
        '-    return 1;',
        '+    const x = 1;',
        '+    return x;',
        '   }',
        '',
      ),
    );
    expect(file).toMatchObject({
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      kind: 'modified',
      binary: false,
    });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]).toMatchObject({
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 5,
      section: 'export class A {',
    });
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: 'context', text: '  one() {', oldNo: 10, newNo: 10 },
      { kind: 'del', text: '    return 1;', oldNo: 11 },
      { kind: 'add', text: '    const x = 1;', newNo: 11 },
      { kind: 'add', text: '    return x;', newNo: 12 },
      { kind: 'context', text: '  }', oldNo: 12, newNo: 13 },
      { kind: 'context', text: '', oldNo: 13, newNo: 14 },
    ]);
  });

  it('defaults omitted hunk counts to 1 and marks missing final newlines', () => {
    const [file] = parseUnifiedDiff(
      diff(
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-a',
        '\\ No newline at end of file',
        '+a',
      ),
    );
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'a', oldNo: 1, noEol: true },
      { kind: 'add', text: 'a', newNo: 1 },
    ]);
  });

  it('parses added, deleted, renamed, mode-only and binary files', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1 @@',
        '+export {};',
        'diff --git a/old.ts b/old.ts',
        'deleted file mode 100644',
        'index 1111111..0000000',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-export {};',
        'diff --git a/from.ts b/to.ts',
        'similarity index 100%',
        'rename from from.ts',
        'rename to to.ts',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/logo.png b/logo.png',
        'new file mode 100644',
        'index 0000000..3333333',
        'Binary files /dev/null and b/logo.png differ',
        'diff --git a/empty.txt b/empty.txt',
        'new file mode 100644',
        'index 0000000..e69de29',
      ),
    );
    expect(files.map((f) => [f.kind, f.oldPath, f.newPath, f.binary, f.hunks.length])).toEqual([
      ['added', null, 'new.ts', false, 1],
      ['deleted', 'old.ts', null, false, 1],
      ['renamed', 'from.ts', 'to.ts', false, 0],
      ['modified', 'run.sh', 'run.sh', false, 0],
      ['added', null, 'logo.png', true, 0],
      ['added', null, 'empty.txt', false, 0],
    ]);
    expect(files[2]!.similarity).toBe(1);
    expect(files[3]).toMatchObject({ oldMode: '100644', newMode: '100755' });
  });

  it('handles quoted paths and paths with spaces', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/my file.ts b/my file.ts',
        '--- a/my file.ts\t',
        '+++ b/my file.ts\t',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/two words.ts b/two words.ts',
        'old mode 100644',
        'new mode 100755',
      ),
    );
    expect(files.map((f) => f.newPath)).toEqual(['tab\there.ts', 'my file.ts', 'two words.ts']);
  });

  it('keeps lines that look like headers inside a hunk', () => {
    const [file] = parseUnifiedDiff(
      diff(
        'diff --git a/a.md b/a.md',
        '--- a/a.md',
        '+++ b/a.md',
        '@@ -1,2 +1,2 @@',
        '---- a/x',
        '++++ b/x',
        ' @@ -1 +1 @@',
      ),
    );
    expect(file!.hunks[0]!.lines.map((l) => [l.kind, l.text])).toEqual([
      ['del', '--- a/x'],
      ['add', '+++ b/x'],
      ['context', '@@ -1 +1 @@'],
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('unquote', () => {
  it('decodes C escapes and octal UTF-8 bytes', () => {
    expect(unquote('"a/caf\\303\\251 \\"x\\".ts"')).toBe('a/café "x".ts');
    expect(unquote('plain.ts')).toBe('plain.ts');
  });
});
