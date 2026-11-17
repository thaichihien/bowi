import { describe, expect, it } from 'vitest';
import { languageForPath, parseSource } from '../src/index.ts';
import { scriptRanges } from '../src/component.ts';

const VUE = `<template>
  <div class="card">
    <UserAvatar :user="user" @click="open" />
    <user-badge>{{ total }}</user-badge>
  </div>
</template>

<script setup lang="ts">
import UserAvatar from './UserAvatar.vue';
const props = defineProps<{ user: User }>();
function open() {
  emit('open', props.user.id);
}
</script>
`;

const SVELTE = `<script lang="ts">
  import Row from './Row.svelte';
  let { items } = $props();
  function remove(id: string) {
    items = items.filter((i) => i.id !== id);
  }
</script>

{#each items as item}
  <Row {item} on:remove={() => remove(item.id)} />
{/each}
`;

const ASTRO = `---
import Layout from '../layouts/Layout.astro';
export function getStaticPaths() {
  return [];
}
const { title } = Astro.props;
---
<Layout title={title}>
  <h1>{title}</h1>
</Layout>
<script>
  document.querySelector('h1')?.addEventListener('click', () => {});
</script>
`;

describe('single-file components (M14)', () => {
  it('knows the languages by extension', () => {
    expect(languageForPath('a/Card.vue')).toBe('vue');
    expect(languageForPath('a/Row.svelte')).toBe('svelte');
    expect(languageForPath('src/pages/index.astro')).toBe('astro');
  });

  it('parses a Vue script in place, with the template as references', async () => {
    const src = await parseSource('vue', VUE);
    expect(src.language).toBe('vue');
    expect(src.hasError).toBe(false);
    expect(src.symbols.map((s) => [s.name, s.startLine])).toContainEqual(['open', 11]);
    expect(src.imports).toEqual([{ source: './UserAvatar.vue', names: ['UserAvatar'], line: 9 }]);
    const names = src.references.filter((r) => r.line <= 6).map((r) => `${r.name}@${r.line}`);
    expect(names).toEqual(
      expect.arrayContaining(['UserAvatar@3', 'user@3', 'open@3', 'UserBadge@4', 'total@4']),
    );
    src.dispose();
  });

  it('sees template changes, and does not take them for formatting', async () => {
    const before = await parseSource('vue', VUE);
    const after = await parseSource('vue', VUE.replace('{{ total }}', '{{ count }}'));
    expect(after.isContentLine(4)).toBe(true);
    expect(before.coverFingerprint(1, 6)).not.toBe(after.coverFingerprint(1, 6));
    const rewrapped = await parseSource(
      'vue',
      VUE.replace(
        '<UserAvatar :user="user" @click="open" />',
        '<UserAvatar\n      :user="user"\n      @click="open"\n    />',
      ),
    );
    expect(rewrapped.coverFingerprint(1, 9)).toBe(before.coverFingerprint(1, 6));
    for (const s of [before, after, rewrapped]) s.dispose();
  });

  it('parses Svelte scripts and markup expressions', async () => {
    const src = await parseSource('svelte', SVELTE);
    expect(src.hasError).toBe(false);
    expect(src.symbols.map((s) => s.name)).toContain('remove');
    const markup = src.references.filter((r) => r.line === 10).map((r) => r.name);
    expect(markup).toEqual(expect.arrayContaining(['Row', 'item', 'remove']));
    src.dispose();
  });

  it('parses Astro frontmatter and client scripts, not the markup', async () => {
    expect(scriptRanges('astro', ASTRO)).toHaveLength(2);
    const src = await parseSource('astro', ASTRO);
    expect(src.hasError).toBe(false);
    expect(src.symbols.map((s) => s.name)).toContain('getStaticPaths');
    expect(src.references.some((r) => r.name === 'Layout' && r.line === 8)).toBe(true);
    expect(src.isContentLine(1)).toBe(true);
    src.dispose();
  });

  it('leaves JSON-LD and other non-script blocks as markup', () => {
    const html = '<script type="application/ld+json">{"a":1}</script><script>let a = 1</script>';
    expect(scriptRanges('svelte', html)).toHaveLength(1);
  });
});
