import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '@bowi/core';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { defaultRules } from '../src/index.ts';

describe('review hint rules (HINT-2)', () => {
  let repo: string;
  let plan: ReviewPlan;
  beforeAll(async () => {
    repo = scratchRepo(
      {
        'package.json': JSON.stringify({ dependencies: { left: '1.0.0' } }, null, 2) + '\n',
        'src/math.ts': 'export function total(a: number): number {\n  return a;\n}\n',
        'src/report.ts':
          "import { total } from './math';\n\nexport function report(): string {\n  return String(total(1));\n}\n",
        'src/routes/users.ts':
          "import { router } from '../router';\n\nrouter.get('/users', list);\n",
        'src/session/store.ts': 'export const ttl = 60;\n',
      },
      {
        'package.json':
          JSON.stringify(
            {
              dependencies: { left: '1.0.0', right: '2.0.0', sibling: 'workspace:*' },
              devDependencies: { tool: '3.0.0' },
            },
            null,
            2,
          ) + '\n',
        'src/math.ts': 'export function total(a: number, b = 0): number {\n  return a + b;\n}\n',
        'src/routes/users.ts':
          "import { router } from '../router';\n\nrouter.get('/users', listAll);\nrouter.post('/users', create);\n// router.delete('/users', remove);\n",
        'test/users.test.ts': "server.get('/fake', handler);\n",
        'db/migrations/001_add_users.sql': 'CREATE TABLE users (id int);\n',
        'src/session/store.ts': 'export const ttl = 120;\n',
      },
    );
    plan = await analyze(
      await openLocalSnapshot({ cwd: repo }),
      createStageContext(DEFAULT_CONFIG),
      {
        toolVersion: 'test',
        hintRules: defaultRules,
      },
    );
  });
  afterAll(() => rmSync(join(repo, '..'), { recursive: true, force: true }));

  it('labels migrations, routes, outside callers, dependencies and auth code', () => {
    expect(plan.hints.map((h) => `${h.ruleId} ${h.severity}: ${h.message}`).sort()).toEqual([
      'auth attention: Authentication or authorization code: src/session/store.ts',
      'migration attention: Database migration: 001_add_users.sql',
      'new-dependency attention: New dependency: right',
      'new-dependency attention: New dev dependency: tool',
      'public-route attention: New route: POST /users',
      'public-route info: Route changed: GET /users',
      'signature-outside-callers attention: `total()` changed its signature; 1 unchanged reference outside this PR',
    ]);
  });

  it('points every hint at a hunk in a step of a group', () => {
    const steps = new Map(plan.groups.flatMap((g) => g.steps.map((s) => [s.id, g.id])));
    for (const h of plan.hints) {
      expect(steps.get(h.target.stepId!)).toBe(h.target.groupId);
      const step = plan.groups.flatMap((g) => g.steps).find((s) => s.id === h.target.stepId)!;
      expect(step.hunkIds).toContain(h.target.hunkId);
    }
  });
});
