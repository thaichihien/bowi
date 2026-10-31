import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '@bowi/core';
import { buildFixtureRepo, emailVerification, scratchRepo } from '@bowi/fixtures';
import { defaultRules } from '@bowi/rules';
import { openLocalSnapshot } from '@bowi/sources';
import { defaultPlugins } from '../src/index.ts';

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const review = async (repo: string): Promise<ReviewPlan> =>
  analyze(await openLocalSnapshot({ cwd: repo }), createStageContext(DEFAULT_CONFIG), {
    toolVersion: 'test',
    plugins: defaultPlugins,
    hintRules: defaultRules,
  });

const layers = (plan: ReviewPlan) => Object.fromEntries(plan.files.map((f) => [f.path, f.layer]));
const framework = (plan: ReviewPlan) =>
  plan.edges.filter((e) => e.type === 'framework').map((e) => e.evidence.text);
const hints = (plan: ReviewPlan) =>
  plan.hints.map((h) => [h.ruleId, h.severity, h.message, h.target.stepId]);

describe('NestJS plugin on the email-verification fixture', () => {
  let plan: ReviewPlan;
  beforeAll(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bowi-nest-'));
    roots.push(tmp);
    plan = await review(buildFixtureRepo(emailVerification, join(tmp, 'repo')).dir);
  });

  it('is detected from package.json and assigns layers from decorators', () => {
    expect(plan.meta.plugins).toEqual(['nestjs']);
    expect(layers(plan)).toMatchObject({
      'src/auth/auth.controller.ts': 'api',
      'src/auth/auth.service.ts': 'service',
      'src/mail/mail.service.ts': 'service',
      'src/migrations/1730_add_email_verified.ts': 'schema',
      'src/users/user.entity.ts': 'data',
      'test/auth.service.spec.ts': 'test',
    });
  });

  it('links the migration to the entity column it adds, so the entity is read first', () => {
    expect(framework(plan)).toEqual([
      '`AddEmailVerified1730` changes column `email_verified` of entity `User`',
    ]);
    const data = plan.groups[0]!.steps[0]!;
    expect(data.hunkIds.map((id) => plan.hunks.find((h) => h.id === id)!.fileId)).toEqual([
      plan.files.find((f) => f.path === 'src/users/user.entity.ts')!.id,
      plan.files.find((f) => f.path === 'src/migrations/1730_add_email_verified.ts')!.id,
    ]);
  });

  it('adds the v0.1 review hints in reading order (HINT-2)', () => {
    expect(hints(plan)).toEqual([
      ['migration', 'attention', 'Database migration: 1730_add_email_verified.ts', 'g1:data'],
      [
        'auth',
        'attention',
        'Authentication or authorization code: src/auth/auth.service.ts',
        'g1:service',
      ],
      [
        'auth',
        'attention',
        'Authentication or authorization code: src/auth/auth.controller.ts',
        'g1:api',
      ],
      ['public-route', 'attention', 'New route: GET /auth/verify-email', 'g1:api'],
      ['moved-behavior', 'attention', '1 line changed inside moved code `slugify()`', 'g2:move1'],
      ['new-dependency', 'attention', 'New dependency: nodemailer', 'g3:generated'],
    ]);
    expect(plan.hints.map((h) => h.id)).toEqual(plan.hints.map((_, i) => `hint${i + 1}`));
    expect(plan.hints.every((h) => h.target.groupId && h.target.hunkId)).toBe(true);
  });
});

describe('NestJS plugin on queues, events, guards, DTOs and modules', () => {
  const pkg = JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0' } });
  const usersService = (head: boolean) =>
    [
      "import { Injectable } from '@nestjs/common';",
      ...(head
        ? [
            "import { InjectQueue } from '@nestjs/bull';",
            "import { EventEmitter2 } from '@nestjs/event-emitter';",
            "import type { Queue } from 'bull';",
          ]
        : []),
      '',
      '@Injectable()',
      'export class UsersService {',
      head
        ? "  constructor(@InjectQueue('mail') private readonly mailQueue: Queue, private readonly events: EventEmitter2) {}"
        : '  constructor() {}',
      '',
      '  async register(email: string) {',
      '    const user = { email };',
      ...(head
        ? [
            "    await this.mailQueue.add('welcome', { email });",
            "    this.events.emit('user.created', user);",
          ]
        : []),
      '    return user;',
      '  }',
      '}',
      '',
    ].join('\n');

  let plan: ReviewPlan;
  beforeAll(async () => {
    const repo = scratchRepo(
      { 'package.json': pkg, 'src/users/users.service.ts': usersService(false) },
      {
        'src/users/users.service.ts': usersService(true),
        'src/mail/mail.processor.ts': [
          "import { Process, Processor } from '@nestjs/bull';",
          '',
          "@Processor('mail')",
          'export class MailProcessor {',
          "  @Process('welcome')",
          '  async sendWelcome(job: { data: { email: string } }) {',
          '    return job.data.email;',
          '  }',
          '}',
          '',
        ].join('\n'),
        'src/users/user-created.listener.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { OnEvent } from '@nestjs/event-emitter';",
          '',
          '@Injectable()',
          'export class UserCreatedListener {',
          "  @OnEvent('user.created')",
          '  handle(user: { email: string }) {',
          '    return user.email;',
          '  }',
          '}',
          '',
        ].join('\n'),
        'src/users/users.controller.ts': [
          "import { Body, Controller, Post, UseGuards } from '@nestjs/common';",
          "import { AdminGuard } from '../admin/admin.guard';",
          "import { CreateUserDto } from './create-user.dto';",
          "import { UsersService } from './users.service';",
          '',
          "@Controller('users')",
          '@UseGuards(AdminGuard)',
          'export class UsersController {',
          '  constructor(private readonly users: UsersService) {}',
          '',
          '  @Post()',
          '  create(@Body() dto: CreateUserDto) {',
          '    return this.users.register(dto.email);',
          '  }',
          '}',
          '',
        ].join('\n'),
        'src/admin/admin.guard.ts': [
          "import { CanActivate, Injectable } from '@nestjs/common';",
          '',
          '@Injectable()',
          'export class AdminGuard implements CanActivate {',
          '  canActivate() {',
          '    return true;',
          '  }',
          '}',
          '',
        ].join('\n'),
        'src/users/create-user.ts': [
          "import { IsEmail } from 'class-validator';",
          '',
          'export class CreateUserDto {',
          '  @IsEmail()',
          '  email!: string;',
          '}',
          '',
        ].join('\n'),
        'src/app.ts': [
          "import { Module } from '@nestjs/common';",
          '',
          '@Module({})',
          'export class AppModule {}',
          '',
        ].join('\n'),
      },
    );
    roots.push(join(repo, '..'));
    plan = await review(repo);
  });

  it('reads layers from decorators, not paths', () => {
    expect(layers(plan)).toEqual({
      'src/admin/admin.guard.ts': 'api', // @Injectable() implementing CanActivate
      'src/app.ts': 'config', // @Module
      'src/mail/mail.processor.ts': 'service', // @Processor
      'src/users/create-user.ts': 'data', // validated DTO
      'src/users/user-created.listener.ts': 'service',
      'src/users/users.controller.ts': 'api',
      'src/users/users.service.ts': 'service',
    });
  });

  it('links producers to the handlers of their queue jobs and events, and new injections', () => {
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        '`UsersService.register()` queues job `welcome`, handled by `MailProcessor` (`@Process`)',
        '`UsersService.register()` emits `user.created`, handled by `UserCreatedListener` (`@OnEvent`)',
        '`UsersService.constructor()` uses queue `mail`, handled by `MailProcessor` (`@Processor`)',
        '`UsersController` injects `UsersService`',
      ]),
    );
    // The controller injects the service, so the services step is read before the API step.
    const order = plan.groups.flatMap((g) => g.steps.map((s) => s.title));
    expect(order.indexOf('Services')).toBeLessThan(order.indexOf('API'));
  });

  it('hints at new routes and access control', () => {
    expect(plan.hints.map((h) => h.message)).toEqual(
      expect.arrayContaining([
        'New route: POST /users',
        'Access control changed: `@UseGuards(AdminGuard)` on `UsersController`',
        'Authentication or authorization code: src/admin/admin.guard.ts',
      ]),
    );
  });
});

describe('NestJS plugin detection', () => {
  it('stays off without @nestjs/core or @nestjs/common', async () => {
    const repo = scratchRepo(
      { 'package.json': '{"dependencies":{"express":"^4"}}', 'src/a.ts': 'export const a = 1;\n' },
      {
        'src/a.ts': '@Injectable()\nexport class A {}\nexport const a = 2;\n',
      },
    );
    roots.push(join(repo, '..'));
    const plan = await review(repo);
    expect(plan.meta.plugins).toEqual([]);
    expect(plan.files[0]!.layer).toBe('unknown');
  });
});
