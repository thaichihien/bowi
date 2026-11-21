import { describe, expect, it } from 'vitest';
import { addedDependencies } from '../src/manifests.ts';
import type { DiffLine, Hunk } from '../src/types.ts';

/** One hunk: `+` lines are added (numbered in the new text), `-` lines removed. */
function hunk(newText: string, marked: string): Hunk {
  const lines: DiffLine[] = [];
  const all = newText.split('\n');
  for (const raw of marked.split('\n').filter(Boolean)) {
    const text = raw.slice(1);
    if (raw[0] === '-') lines.push({ kind: 'del', text, oldNo: 1 });
    else lines.push({ kind: 'add', text, newNo: all.indexOf(text) + 1 });
  }
  return {
    id: 'f0:h0',
    fileId: 'f0',
    header: '',
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 0,
    lines,
    kind: 'logic',
    symbolIds: [],
  };
}
const deps = (path: string, text: string, marked: string) =>
  addedDependencies(path, text, [hunk(text, marked)]);

describe('dependencies added in Python and Go manifests (M15)', () => {
  it('reads requirements files, dev ones by their name', () => {
    const text = '# web\nfastapi==0.110.0\nrequests[socks]>=2.31\n-r base.txt\n';
    expect(
      deps('requirements.txt', text, '+fastapi==0.110.0\n+requests[socks]>=2.31\n+-r base.txt'),
    ).toEqual([
      { name: 'fastapi', dev: false },
      { name: 'requests', dev: false },
    ]);
    expect(deps('requirements-dev.txt', 'pytest\n', '+pytest')).toEqual([
      { name: 'pytest', dev: true },
    ]);
  });

  it('does not count a version bump', () => {
    expect(
      deps('requirements.txt', 'fastapi==0.111.0\n', '-fastapi==0.110.0\n+fastapi==0.111.0'),
    ).toEqual([]);
  });

  it('reads pyproject.toml lists and tables, by section', () => {
    const text = [
      '[project]',
      'name = "app"',
      'version = "1.0"',
      'dependencies = [',
      '  "fastapi>=0.110",',
      '  "pydantic",',
      ']',
      '',
      '[project.optional-dependencies]',
      'test = ["pytest>=8"]',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'ruff = "^0.4"',
    ].join('\n');
    expect(
      deps(
        'pyproject.toml',
        text,
        '+name = "app"\n+  "fastapi>=0.110",\n+  "pydantic",\n+test = ["pytest>=8"]\n+ruff = "^0.4"',
      ),
    ).toEqual([
      { name: 'fastapi', dev: false },
      { name: 'pydantic', dev: false },
      { name: 'pytest', dev: true },
      { name: 'ruff', dev: true },
    ]);
  });

  it('reads go.mod requirements, without indirect ones', () => {
    const text = [
      'module github.com/acme/app',
      '',
      'require (',
      '\tgithub.com/gorilla/mux v1.8.1',
      '\tgolang.org/x/sys v0.20.0 // indirect',
      ')',
      'require github.com/google/uuid v1.6.0',
    ].join('\n');
    expect(
      deps(
        'go.mod',
        text,
        '+\tgithub.com/gorilla/mux v1.8.1\n+\tgolang.org/x/sys v0.20.0 // indirect\n+require github.com/google/uuid v1.6.0',
      ),
    ).toEqual([
      { name: 'github.com/gorilla/mux', dev: false },
      { name: 'github.com/google/uuid', dev: false },
    ]);
  });
});
