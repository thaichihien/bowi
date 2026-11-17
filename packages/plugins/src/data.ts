/**
 * Database libraries (M14), so that models are read before the code using them in any Node.js
 * back end. NestJS projects get the same from the NestJS plugin, which comes first.
 *
 * - TypeORM (`typeorm`): `@Entity` classes → data, migrations (`MigrationInterface`) → schema;
 *   a migration naming a column an entity adds depends on the entity (as for NestJS).
 * - Sequelize (`sequelize`, `sequelize-typescript`): models (`extends Model`, `define()`,
 *   `init()`, `@Table`) → data.
 * - Mongoose (`mongoose`): schemas and models (`new Schema`, `model()`) → data.
 * - Drizzle (`drizzle-orm`): table definitions (`pgTable`, `mysqlTable`, `sqliteTable`, enums)
 *   → schema, like a Prisma schema.
 */

import type { FileChange, FileSources, FrameworkPlugin, Layer } from '@bowi/core';
import { columnEdges } from './nestjs.ts';
import {
  Changes,
  importsFrom,
  SCRIPT_LANGUAGES,
  sourceOf,
  TEST_PATH,
  usesPackage,
} from './shared.ts';

const code = (file: FileChange) =>
  !!file.language && SCRIPT_LANGUAGES.has(file.language) && !TEST_PATH.test(file.path);

export const typeormPlugin: FrameworkPlugin = {
  id: 'typeorm',
  detect: (repo) => usesPackage(repo, ['typeorm']),
  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!code(file) || !src) return undefined;
    if (src.classes.some((c) => c.implements.includes('MigrationInterface'))) return 'schema';
    const entity = src.decorators.some(
      (d) => d.target.kind === 'class' && (d.name === 'Entity' || d.name === 'ViewEntity'),
    );
    return entity ? 'data' : undefined;
  },
  extraEdges: (input) => columnEdges(new Changes(input)),
};

export const sequelizePlugin: FrameworkPlugin = {
  id: 'sequelize',
  detect: (repo) => usesPackage(repo, ['sequelize', 'sequelize-typescript']),
  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!code(file) || !src || !importsFrom(src, /^sequelize(-typescript)?(\/|$)/))
      return undefined;
    const model =
      src.classes.some((c) => c.extends.includes('Model')) ||
      src.decorators.some((d) => d.name === 'Table') ||
      src.references.some((r) => r.kind === 'call' && (r.name === 'define' || r.name === 'init'));
    return model ? 'data' : undefined;
  },
};

export const mongoosePlugin: FrameworkPlugin = {
  id: 'mongoose',
  detect: (repo) => usesPackage(repo, ['mongoose']),
  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!code(file) || !src || !importsFrom(src, /^mongoose(\/|$)/)) return undefined;
    const model = src.references.some(
      (r) => (r.kind === 'new' && r.name === 'Schema') || (r.kind === 'call' && r.name === 'model'),
    );
    return model ? 'data' : undefined;
  },
};

const DRIZZLE_TABLES = new Set([
  'pgTable',
  'mysqlTable',
  'sqliteTable',
  'pgEnum',
  'mysqlEnum',
  'pgSchema',
  'pgView',
  'relations',
]);

export const drizzlePlugin: FrameworkPlugin = {
  id: 'drizzle',
  detect: (repo) => usesPackage(repo, ['drizzle-orm']),
  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!code(file) || !src || !importsFrom(src, /^drizzle-orm\//)) return undefined;
    return src.references.some((r) => r.kind === 'call' && DRIZZLE_TABLES.has(r.name))
      ? 'schema'
      : undefined;
  },
};
