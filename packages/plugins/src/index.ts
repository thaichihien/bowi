/**
 * Framework plugins (PLG-1, PLG-2, M14, M17). The interface lives in `@bowi/core`
 * (`FrameworkPlugin`); `defaultPlugins` are the ones the CLI tries on every run. Order matters
 * for layers: the first detected plugin that names a file's layer wins, so meta-frameworks come
 * before the libraries they build on (Next.js before React, Nuxt before Vue, SvelteKit before
 * Svelte), and database libraries before HTTP frameworks (a model file that imports `Request` is
 * still a model). The plugins of other languages (M17) read only their own language's files, so
 * their place among the others does not matter.
 */

import type { FrameworkPlugin } from '@bowi/core';
import { angularPlugin } from './angular.ts';
import { drizzlePlugin, mongoosePlugin, sequelizePlugin, typeormPlugin } from './data.ts';
import { aspnetPlugin } from './aspnet.ts';
import { astroPlugin } from './astro.ts';
import { djangoPlugin } from './django.ts';
import { goHttpPlugin } from './go-http.ts';
import { nestjsPlugin } from './nestjs.ts';
import { nextPlugin } from './next.ts';
import { reactRouterPlugin } from './react-router.ts';
import { fastapiPlugin, flaskPlugin } from './python-web.ts';
import { reactPlugin } from './react.ts';
import { expressPlugin, fastifyPlugin, honoPlugin, koaPlugin } from './server.ts';
import { solidPlugin } from './solid.ts';
import { springPlugin } from './spring.ts';
import { svelteKitPlugin, sveltePlugin } from './svelte.ts';
import { trpcPlugin } from './trpc.ts';
import { nuxtPlugin, vuePlugin } from './vue.ts';

export { angularPlugin } from './angular.ts';
export { drizzlePlugin, mongoosePlugin, sequelizePlugin, typeormPlugin } from './data.ts';
export { aspnetPlugin } from './aspnet.ts';
export { astroPlugin } from './astro.ts';
export { djangoPlugin } from './django.ts';
export { goHttpPlugin } from './go-http.ts';
export { nestjsPlugin } from './nestjs.ts';
export { nextPlugin } from './next.ts';
export { reactRouterPlugin } from './react-router.ts';
export { fastapiPlugin, flaskPlugin } from './python-web.ts';
export { reactPlugin } from './react.ts';
export { expressPlugin, fastifyPlugin, honoPlugin, koaPlugin } from './server.ts';
export { solidPlugin } from './solid.ts';
export { springPlugin } from './spring.ts';
export { svelteKitPlugin, sveltePlugin } from './svelte.ts';
export { trpcPlugin } from './trpc.ts';
export { nuxtPlugin, vuePlugin } from './vue.ts';

export const defaultPlugins: FrameworkPlugin[] = [
  nestjsPlugin,
  angularPlugin,
  nextPlugin,
  reactRouterPlugin,
  nuxtPlugin,
  svelteKitPlugin,
  astroPlugin,
  vuePlugin,
  sveltePlugin,
  solidPlugin,
  reactPlugin,
  // Back ends: models first, so a model in a route file's folder is still data.
  typeormPlugin,
  sequelizePlugin,
  mongoosePlugin,
  drizzlePlugin,
  trpcPlugin,
  honoPlugin,
  fastifyPlugin,
  koaPlugin,
  expressPlugin,
  // Other languages (M17).
  djangoPlugin,
  fastapiPlugin,
  flaskPlugin,
  goHttpPlugin,
  springPlugin,
  aspnetPlugin,
];
