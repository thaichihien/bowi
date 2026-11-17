import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '@bowi/core';
import { scratchRepo } from '@bowi/fixtures';
import { defaultRules } from '@bowi/rules';
import { openLocalSnapshot } from '@bowi/sources';
import { defaultPlugins } from '../src/index.ts';

// scratchRepo returns `<its own temporary folder>/repo`: remove that folder, nothing above it.
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

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'api', dependencies: deps });
const layers = (plan: ReviewPlan) => Object.fromEntries(plan.files.map((f) => [f.path, f.layer]));
const framework = (plan: ReviewPlan) =>
  plan.edges.filter((e) => e.type === 'framework').map((e) => e.evidence.text);
const messages = (plan: ReviewPlan) => plan.hints.map((h) => h.message);

describe('Express and the database libraries', () => {
  it('reads route modules, middleware and models, and links a mounted router', async () => {
    const plan = await review(
      {
        'package.json': pkg({ express: '4.21.0', sequelize: '6.37.0' }),
        'src/app.ts':
          "import express from 'express';\nexport const app = express();\napp.use(express.json());\n",
        'src/lib/mailer.ts': 'export function send(to: string) {\n  return to;\n}\n',
      },
      {
        'src/app.ts':
          "import express from 'express';\nimport userRoutes from './routes/users';\nexport const app = express();\napp.use(express.json());\napp.use('/users', userRoutes);\n",
        'src/routes/users.ts':
          "import { Router } from 'express';\nimport { User } from '../models/user';\nconst router = Router();\nrouter.post('/', async (req, res) => {\n  res.json(await User.create(req.body));\n});\nexport default router;\n",
        'src/middleware/auth.ts':
          "import type { Request, Response, NextFunction } from 'express';\nexport function requireUser(req: Request, res: Response, next: NextFunction) {\n  next();\n}\n",
        'src/models/user.ts':
          "import { DataTypes, Model } from 'sequelize';\nexport class User extends Model {}\nUser.init({ email: DataTypes.STRING }, { sequelize: null as never });\n",
        'src/lib/mailer.ts': 'export function send(to: string) {\n  return to.trim();\n}\n',
      },
    );
    expect(plan.meta.plugins).toEqual(['sequelize', 'express']);
    expect(layers(plan)).toMatchObject({
      'src/app.ts': 'api',
      'src/routes/users.ts': 'api',
      'src/middleware/auth.ts': 'api',
      'src/models/user.ts': 'data',
      'src/lib/mailer.ts': 'util',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('mounts `userRoutes` from `src/routes/users.ts`'),
      ]),
    );
    expect(messages(plan)).toContain('New route: POST /');
  });

  it('reads Mongoose models, Drizzle tables and TypeORM entities outside NestJS', async () => {
    const plan = await review(
      {
        'package.json': pkg({
          fastify: '5.0.0',
          mongoose: '8.0.0',
          'drizzle-orm': '0.40.0',
          typeorm: '0.3.0',
        }),
      },
      {
        'src/models/post.ts':
          "import mongoose from 'mongoose';\nconst schema = new mongoose.Schema({ title: String });\nexport const Post = mongoose.model('Post', schema);\n",
        'src/db/tables.ts':
          "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { id: text('id') });\n",
        'src/entities/order.ts':
          "import { Entity, Column } from 'typeorm';\n@Entity()\nexport class Order {\n  @Column() total: number;\n}\n",
        'src/plugins/posts.ts':
          "import type { FastifyInstance } from 'fastify';\nexport default async function posts(fastify: FastifyInstance) {\n  fastify.get('/posts', async () => []);\n}\n",
      },
    );
    expect(layers(plan)).toMatchObject({
      'src/models/post.ts': 'data',
      'src/db/tables.ts': 'schema',
      'src/entities/order.ts': 'data',
      'src/plugins/posts.ts': 'api',
    });
  });
});

describe('Hono and tRPC', () => {
  it('reads a Hono app and links a client call to the tRPC procedure it uses', async () => {
    const plan = await review(
      {
        'package.json': pkg({ hono: '4.0.0', '@trpc/server': '11.0.0', '@trpc/client': '11.0.0' }),
        'src/trpc/init.ts':
          "import { initTRPC } from '@trpc/server';\nconst t = initTRPC.create();\nexport const router = t.router;\nexport const publicProcedure = t.procedure;\n",
        'src/trpc/routers/user.ts':
          "import { router, publicProcedure } from '../init';\nexport const userRouter = router({\n  list: publicProcedure.query(() => []),\n});\n",
        'src/web/users.ts':
          "import { client } from './client';\nexport async function loadUsers() {\n  return client.user.list.query();\n}\n",
      },
      {
        'src/trpc/routers/user.ts':
          "import { router, publicProcedure } from '../init';\nexport const userRouter = router({\n  list: publicProcedure.query(() => []),\n  byEmail: publicProcedure.query(() => null),\n});\n",
        'src/web/users.ts':
          "import { client } from './client';\nexport async function loadUsers() {\n  return client.user.list.query();\n}\nexport async function findUser() {\n  return client.user.byEmail.query();\n}\n",
        'src/server.ts':
          "import { Hono } from 'hono';\nimport health from './routes/health';\nconst app = new Hono();\napp.route('/health', health);\nexport default app;\n",
        'src/routes/health.ts':
          "import { Hono } from 'hono';\nconst health = new Hono();\nhealth.get('/', (c) => c.text('ok'));\nexport default health;\n",
      },
    );
    expect(plan.meta.plugins).toEqual(['trpc', 'hono']);
    expect(layers(plan)).toMatchObject({
      'src/trpc/routers/user.ts': 'api',
      'src/server.ts': 'api',
      'src/routes/health.ts': 'api',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('calls tRPC procedure `byEmail`, defined in `userRouter`'),
        expect.stringContaining('mounts `health` from `src/routes/health.ts`'),
      ]),
    );
    expect(messages(plan)).toContain('New tRPC procedure: `byEmail`');
  });
});
