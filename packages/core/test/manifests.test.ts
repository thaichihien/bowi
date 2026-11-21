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

describe('dependencies added in Maven, Gradle and NuGet manifests (M16)', () => {
  it('reads pom.xml dependencies, not plugins or exclusions; test scope is dev', () => {
    const text = [
      '<project>',
      '  <artifactId>app</artifactId>',
      '  <dependencies>',
      '    <dependency>',
      '      <groupId>org.postgresql</groupId>',
      '      <artifactId>postgresql</artifactId>',
      '      <exclusions><exclusion>',
      '        <artifactId>checker-qual</artifactId>',
      '      </exclusion></exclusions>',
      '    </dependency>',
      '    <dependency>',
      '      <artifactId>junit-jupiter</artifactId>',
      '      <scope>test</scope>',
      '    </dependency>',
      '  </dependencies>',
      '  <build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId></plugin></plugins></build>',
      '</project>',
    ].join('\n');
    const added = text
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n');
    expect(deps('pom.xml', text, added)).toEqual([
      { name: 'postgresql', dev: false },
      { name: 'junit-jupiter', dev: true },
    ]);
  });

  it('reads Gradle coordinates and catalog references; a version bump is not new', () => {
    const text = [
      'plugins {',
      '  alias(libs.plugins.kotlin.jvm)',
      '}',
      'dependencies {',
      '  implementation("com.acme:bytes:3.9.0")',
      '  api(platform("org.jetbrains.kotlin:kotlin-bom:2.0.0"))',
      '  testImplementation(libs.assertk)',
      "  kapt 'com.google.dagger:dagger-compiler:2.51'",
      '  implementation(libs.androidx.core.ktx)',
      '}',
    ].join('\n');
    expect(
      deps(
        'netlib/build.gradle.kts',
        text,
        [
          '+  alias(libs.plugins.kotlin.jvm)',
          '+  implementation("com.acme:bytes:3.9.0")',
          '-  implementation("com.acme:bytes:3.8.0")',
          '+  api(platform("org.jetbrains.kotlin:kotlin-bom:2.0.0"))',
          '+  testImplementation(libs.assertk)',
          "+  kapt 'com.google.dagger:dagger-compiler:2.51'",
          '+  implementation(libs.androidx.core.ktx)',
        ].join('\n'),
      ),
    ).toEqual([
      { name: 'org.jetbrains.kotlin:kotlin-bom', dev: false },
      { name: 'assertk', dev: true },
      { name: 'com.google.dagger:dagger-compiler', dev: false },
      { name: 'androidx-core-ktx', dev: false },
    ]);
  });

  it('reads a version catalog’s libraries', () => {
    const text = [
      '[versions]',
      'bytes = "3.9.0"',
      '[libraries]',
      'bytes = { module = "com.acme:bytes", version.ref = "bytes" }',
      'hilt = { group = "com.google.dagger", name = "hilt-android" }',
      'junit = "junit:junit:4.13.2"',
    ].join('\n');
    const added = text
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n');
    expect(deps('gradle/libs.versions.toml', text, added)).toEqual([
      { name: 'com.acme:bytes', dev: false },
      { name: 'com.google.dagger:hilt-android', dev: false },
      { name: 'junit:junit', dev: false },
    ]);
  });

  it('reads NuGet package references; a test project’s are dev', () => {
    const text =
      '<Project>\n  <ItemGroup>\n    <PackageReference Include="Dapper" Version="2.1.35" />\n  </ItemGroup>\n</Project>\n';
    const line = '+    <PackageReference Include="Dapper" Version="2.1.35" />';
    expect(deps('src/Core/Core.csproj', text, line)).toEqual([{ name: 'Dapper', dev: false }]);
    expect(deps('test/Core.Test/Core.Test.csproj', text, line)).toEqual([
      { name: 'Dapper', dev: true },
    ]);
    expect(
      deps(
        'Directory.Packages.props',
        '<PackageVersion Include="xunit" Version="2.9.0" />\n',
        '+<PackageVersion Include="xunit" Version="2.9.0" />',
      ),
    ).toEqual([{ name: 'xunit', dev: false }]);
  });
});
