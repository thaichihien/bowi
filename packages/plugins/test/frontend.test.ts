import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '@bowi/core';
import { scratchRepo } from '@bowi/fixtures';
import { defaultRules } from '@bowi/rules';
import { openLocalSnapshot } from '@bowi/sources';
import { defaultPlugins } from '../src/index.ts';
import { flatRoute } from '../src/react-router.ts';
import { routePath } from '../src/shared.ts';

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function review(
  base: Record<string, string>,
  head: Record<string, string | null>,
): Promise<ReviewPlan> {
  const repo = scratchRepo(base, head);
  roots.push(dirname(repo));
  return analyze(await openLocalSnapshot({ cwd: repo }), createStageContext(DEFAULT_CONFIG), {
    toolVersion: 'test',
    plugins: defaultPlugins,
    hintRules: defaultRules,
  });
}

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: deps });
const layers = (plan: ReviewPlan) => Object.fromEntries(plan.files.map((f) => [f.path, f.layer]));
const framework = (plan: ReviewPlan) =>
  plan.edges.filter((e) => e.type === 'framework').map((e) => e.evidence.text);
const messages = (plan: ReviewPlan) => plan.hints.map((h) => h.message);

describe('routes from file paths', () => {
  it('reads folders and file names as Next.js, SvelteKit and Nuxt do', () => {
    expect(routePath(['(auth)', 'settings', '[id]'])).toBe('/settings/:id');
    expect(routePath(['blog', '[...slug]'])).toBe('/blog/*slug');
    expect(routePath(['[[lang]]', 'about'])).toBe('/:lang?/about');
    expect(routePath(['albums', '[albumId=id]', 'index'])).toBe('/albums/:albumId');
    expect(routePath(['@modal', 'photo'])).toBe('/photo');
  });

  it('reads React Router flat route names', () => {
    expect(flatRoute('app/routes/_index.tsx')).toBe('/');
    expect(flatRoute('app/routes/settings.billing.tsx')).toBe('/settings/billing');
    expect(flatRoute('app/routes/users.$id_.edit.tsx')).toBe('/users/:id/edit');
    expect(flatRoute('app/routes/_auth.login/route.tsx')).toBe('/login');
    expect(flatRoute('app/routes/files.$.tsx')).toBe('/files/*');
    expect(flatRoute('app/routes/_auth.login/form.tsx')).toBeUndefined();
    expect(flatRoute('app/utils/x.ts')).toBeUndefined();
  });
});

describe('Next.js and React', () => {
  it('finds API routes, server actions, hooks, layouts and new pages', async () => {
    const plan = await review(
      {
        'package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
        'app/settings/layout.tsx':
          'export default function Layout({ children }) {\n  return <main>{children}</main>;\n}\n',
        'hooks/useUser.ts': 'export function useUser() {\n  return { name: "a" };\n}\n',
      },
      {
        'app/settings/layout.tsx':
          'export default function Layout({ children }) {\n  return <main className="s">{children}</main>;\n}\n',
        'app/settings/billing/page.tsx':
          "import { useUser } from '../../../hooks/useUser';\nexport default function Billing() {\n  const u = useUser();\n  return <h1>{u.plan}</h1>;\n}\n",
        'app/settings/billing/loading.tsx':
          'export default function Loading() {\n  return <p>Loading</p>;\n}\n',
        'app/api/users/route.ts':
          'export async function GET() {\n  return Response.json([]);\n}\nexport async function POST() {\n  return Response.json({});\n}\n',
        'app/settings/actions.ts':
          "'use server';\nexport async function savePlan(plan: string) {\n  return plan;\n}\n",
        'hooks/useUser.ts':
          'export function useUser() {\n  return { name: "a", plan: "pro" };\n}\n',
      },
    );
    expect(plan.meta.plugins).toEqual(['nextjs', 'react']);
    expect(layers(plan)).toMatchObject({
      'app/api/users/route.ts': 'api',
      'app/settings/actions.ts': 'api',
      'hooks/useUser.ts': 'util',
      'app/settings/billing/page.tsx': 'ui',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '`app/settings/billing/page.tsx` is rendered inside `app/settings/layout.tsx`',
        ),
        expect.stringContaining(
          '`app/settings/billing/loading.tsx` is shown for `app/settings/billing/page.tsx`',
        ),
      ]),
    );
    expect(messages(plan)).toEqual(
      expect.arrayContaining([
        'New page: /settings/billing',
        'New API route: GET, POST /api/users',
      ]),
    );
  });
});

describe('Vue and Nuxt', () => {
  it('links pages to auto-imported components and composables, and finds server routes', async () => {
    const card = (extra: string) =>
      `<template>\n  <div class="card">{{ user.name }}${extra}</div>\n</template>\n\n<script setup lang="ts">\ndefineProps<{ user: { name: string } }>();\n</script>\n`;
    const plan = await review(
      {
        'package.json': pkg({ nuxt: '4.0.0', vue: '3.5.0' }),
        'components/user/Card.vue': card(''),
        'composables/useUser.ts': 'export function useUser(id: string) {\n  return { id };\n}\n',
      },
      {
        'components/user/Card.vue': card(' <small>{{ user.role }}</small>'),
        'composables/useUser.ts':
          'export function useUser(id: string) {\n  return { id, role: "admin" };\n}\n',
        'pages/users/[id].vue':
          '<template>\n  <UserCard :user="user" />\n</template>\n\n<script setup lang="ts">\nconst route = useRoute();\nconst user = useUser(String(route.params.id));\n</script>\n',
        'server/api/users.post.ts':
          'export default defineEventHandler(async (event) => {\n  return readBody(event);\n});\n',
        'stores/user.ts':
          "export const useUserStore = defineStore('user', {\n  state: () => ({ name: '' }),\n});\n",
      },
    );
    expect(plan.meta.plugins).toEqual(['nuxt', 'vue']);
    expect(plan.meta.languages).toContain('vue');
    expect(layers(plan)).toMatchObject({
      'server/api/users.post.ts': 'api',
      'composables/useUser.ts': 'util',
      'stores/user.ts': 'service',
      'pages/users/[id].vue': 'ui',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('uses `<UserCard>`'),
        expect.stringContaining('calls `useUser()` (auto-imported)'),
      ]),
    );
    expect(messages(plan)).toEqual(
      expect.arrayContaining(['New page: /users/:id', 'New API route: POST /api/users']),
    );
    // A template-only change is a real change, not formatting.
    const cardHunks = plan.hunks.filter(
      (h) => h.fileId === plan.files.find((f) => f.path === 'components/user/Card.vue')!.id,
    );
    expect(cardHunks.map((h) => h.kind)).toEqual(['logic']);
  });
});

describe('Svelte and SvelteKit', () => {
  it('links a page to its load function, layout and components', async () => {
    const plan = await review(
      {
        'package.json': pkg({ '@sveltejs/kit': '2.0.0', svelte: '5.0.0' }),
        'src/routes/+layout.svelte': '<slot />\n',
        'src/lib/components/Row.svelte':
          '<script lang="ts">\n  let { item } = $props();\n</script>\n\n<li>{item.name}</li>\n',
      },
      {
        'src/routes/+layout.svelte': '<nav>Home</nav>\n<slot />\n',
        'src/lib/components/Row.svelte':
          '<script lang="ts">\n  let { item } = $props();\n</script>\n\n<li>{item.name} ({item.count})</li>\n',
        'src/routes/items/+page.svelte':
          '<script lang="ts">\n  import Row from \'$lib/components/Row.svelte\';\n  let { data } = $props();\n</script>\n\n{#each data.items as item}\n  <Row {item} />\n{/each}\n',
        'src/routes/items/+page.server.ts':
          'export async function load() {\n  return { items: [] };\n}\n',
        'src/routes/api/items/+server.ts':
          'export async function GET() {\n  return new Response("[]");\n}\n',
        'src/lib/stores/count.ts':
          "import { writable } from 'svelte/store';\nexport const count = writable(0);\n",
      },
    );
    expect(plan.meta.plugins).toEqual(['sveltekit', 'svelte']);
    expect(layers(plan)).toMatchObject({
      'src/routes/items/+page.server.ts': 'api',
      'src/routes/api/items/+server.ts': 'api',
      'src/lib/stores/count.ts': 'service',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('shows the data of `src/routes/items/+page.server.ts`'),
        expect.stringContaining('is rendered inside `src/routes/+layout.svelte`'),
        expect.stringContaining('imports `Row`'),
      ]),
    );
    expect(messages(plan)).toEqual(
      expect.arrayContaining(['New page: /items', 'New API route: GET /api/items']),
    );
  });
});

describe('Angular', () => {
  it('reads decorators, templates, selectors and injection', async () => {
    const component = (title: string) =>
      `import { Component } from '@angular/core';\n@Component({\n  selector: 'app-user-card',\n  templateUrl: './user-card.component.html',\n  styleUrls: ['./user-card.component.scss'],\n})\nexport class UserCardComponent {\n  title = '${title}';\n}\n`;
    const plan = await review(
      {
        'package.json': pkg({ '@angular/core': '20.0.0' }),
        'src/app/user-card/user-card.component.ts': component('User'),
        'src/app/user-card/user-card.component.html': '<h2>{{ title }}</h2>\n',
        'src/app/user-card/user-card.component.scss': 'h2 { color: red; }\n',
        'src/app/users/users.service.ts':
          "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class UsersService {\n  list() {\n    return [];\n  }\n}\n",
        'src/app/users/users-page.component.ts':
          "import { Component } from '@angular/core';\n@Component({ selector: 'app-users-page', templateUrl: './users-page.component.html' })\nexport class UsersPageComponent {\n  constructor() {}\n}\n",
        'src/app/users/users-page.component.html': '<h1>Users</h1>\n',
      },
      {
        'src/app/user-card/user-card.component.ts': component('Member'),
        'src/app/user-card/user-card.component.html': '<h2>{{ title }}</h2>\n<p>Active</p>\n',
        'src/app/user-card/user-card.component.scss': 'h2 { color: blue; }\n',
        'src/app/users/users.service.ts':
          "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class UsersService {\n  list() {\n    return [1];\n  }\n}\n",
        'src/app/users/users-page.component.ts':
          "import { Component } from '@angular/core';\nimport { UsersService } from './users.service';\n@Component({ selector: 'app-users-page', templateUrl: './users-page.component.html' })\nexport class UsersPageComponent {\n  constructor(private users: UsersService) {}\n}\n",
        'src/app/users/users-page.component.html':
          '<h1>Users</h1>\n<app-user-card></app-user-card>\n',
        'src/app/app.routes.ts':
          "import { Routes } from '@angular/router';\nexport const routes: Routes = [\n  { path: 'users', loadComponent: () => import('./users/users-page.component') },\n];\n",
      },
    );
    expect(plan.meta.plugins).toEqual(['angular']);
    expect(layers(plan)).toMatchObject({
      'src/app/user-card/user-card.component.ts': 'ui',
      'src/app/users/users.service.ts': 'service',
      'src/app/app.routes.ts': 'config',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('`src/app/user-card/user-card.component.html` is the template of'),
        expect.stringContaining('`src/app/user-card/user-card.component.scss` is the style of'),
        expect.stringContaining('uses `<app-user-card>`'),
        '`UsersPageComponent` injects `UsersService`',
      ]),
    );
    expect(messages(plan)).toContain('New route: /users');
  });
});

describe('React Router, SolidStart and Astro', () => {
  it('reads React Router route modules', async () => {
    const plan = await review(
      {
        'package.json': pkg({
          'react-router': '7.0.0',
          '@react-router/dev': '7.0.0',
          react: '19.0.0',
        }),
      },
      {
        'app/routes/settings.billing.tsx':
          'export async function loader() {\n  return { plan: "pro" };\n}\nexport default function Billing() {\n  return <h1>Billing</h1>;\n}\n',
        'app/utils/db.server.ts': 'export const db = {};\n',
      },
    );
    expect(plan.meta.plugins).toEqual(['react-router', 'react']);
    expect(layers(plan)).toMatchObject({
      'app/routes/settings.billing.tsx': 'api',
      'app/utils/db.server.ts': 'service',
    });
    expect(messages(plan)).toContain('New page: /settings/billing');
  });

  it('reads SolidStart routes and stores', async () => {
    const plan = await review(
      { 'package.json': pkg({ 'solid-js': '1.9.0', '@solidjs/start': '1.0.0' }) },
      {
        'src/routes/api/todos.ts': 'export async function GET() {\n  return [];\n}\n',
        'src/routes/todos/[id].tsx': 'export default function Todo() {\n  return <p>Todo</p>;\n}\n',
        'src/state/todos.ts':
          "import { createStore } from 'solid-js/store';\nexport const [todos, setTodos] = createStore([]);\n",
      },
    );
    expect(plan.meta.plugins).toEqual(['solid']);
    expect(layers(plan)).toMatchObject({
      'src/routes/api/todos.ts': 'api',
      'src/state/todos.ts': 'service',
    });
    expect(messages(plan)).toEqual(
      expect.arrayContaining(['New page: /todos/:id', 'New API route: GET /api/todos']),
    );
  });

  it('links Astro pages to their layouts and finds endpoints', async () => {
    const layout = (title: string) =>
      `---\nconst { title } = Astro.props;\n---\n<html><head><title>{title} | ${title}</title></head><body><slot /></body></html>\n`;
    const plan = await review(
      {
        'package.json': pkg({ astro: '5.0.0' }),
        'src/layouts/BaseLayout.astro': layout('Site'),
      },
      {
        'src/layouts/BaseLayout.astro': layout('Blog'),
        'src/pages/blog/[slug].astro':
          "---\nimport BaseLayout from '../../layouts/BaseLayout.astro';\nconst { slug } = Astro.params;\n---\n<BaseLayout title={slug}>\n  <h1>{slug}</h1>\n</BaseLayout>\n",
        'src/pages/rss.xml.ts': 'export async function GET() {\n  return new Response("");\n}\n',
      },
    );
    expect(plan.meta.plugins).toEqual(['astro']);
    expect(layers(plan)).toMatchObject({ 'src/pages/rss.xml.ts': 'api' });
    expect(framework(plan)).toEqual(
      expect.arrayContaining(['`src/pages/blog/[slug].astro` imports `BaseLayout`']),
    );
    expect(messages(plan)).toEqual(
      expect.arrayContaining(['New page: /blog/:slug', 'New API route: GET /rss.xml']),
    );
  });
});
