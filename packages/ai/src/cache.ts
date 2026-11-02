/**
 * Answer cache (AI-6): an AI answer is kept under a hash of everything that went into the
 * request (prompt version, provider, model, system prompt, prompt, answer schema), so a second
 * run on the same changes asks nothing and gets the same text. Only valid answers are kept.
 *
 * Layout: `<dir>/<first 2 hex digits>/<sha256>.json`. Any file can be deleted at any time; a
 * file that cannot be read counts as a miss.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiAnswer } from '@bowi/core';

export function answerKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

const pathOf = (dir: string, key: string) => join(dir, key.slice(0, 2), `${key}.json`);

export async function readAnswer(dir: string, key: string): Promise<AiAnswer | undefined> {
  try {
    const value = JSON.parse(await readFile(pathOf(dir, key), 'utf8')) as Partial<AiAnswer>;
    if (!value || typeof value !== 'object' || !('output' in value)) return undefined;
    return { output: value.output, ...(typeof value.model === 'string' && { model: value.model }) };
  } catch {
    return undefined;
  }
}

/** Writes through a temporary file, so a concurrent run never reads half an answer. */
export async function writeAnswer(dir: string, key: string, answer: AiAnswer): Promise<void> {
  const path = pathOf(dir, key);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  const { output, model } = answer;
  await writeFile(temp, JSON.stringify({ output, ...(model && { model }) }) + '\n');
  try {
    await rename(temp, path);
  } catch (e) {
    // Windows cannot replace a file another run has open; that run wrote the same answer.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
    await rm(temp, { force: true });
  }
}
