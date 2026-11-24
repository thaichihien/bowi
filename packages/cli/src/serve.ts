/**
 * `bowi serve <dir>` and `--serve` on a run (CLI-13, M10): serves a report on this computer so
 * its page can save comments into review-plan.json. A page opened as a file cannot write files.
 *
 * Only 127.0.0.1, on a free port, with a random token every request must carry: in the address
 * (`?t=`) for the page, in the `X-Bowi-Token` header for the API, so no other page in the browser
 * can read or write. The `Host` header must name this server and an `Origin`, when sent, the
 * page's own, which shuts out DNS rebinding. The only thing it writes is the review of this one
 * folder. It contacts GitHub or GitLab only when the reviewer presses "Post to GitHub" (or GitLab),
 * with the login found at that moment; the page never sees the token and talks only to this server
 * (NFR-3, M11, M13). The API keeps the names `/api/github…` for both hosts.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  emptyReview,
  hasReview,
  HostError,
  keepSent,
  parseReview,
  requestWords,
  setPosted,
  UsageError,
  type PostedMark,
  type PostRequest,
} from '@bowi/core';
import { supportsComments, withReview } from '@bowi/render-html';
import { HTML_FILE, PLAN_FILE, planJson, readReport, writeFileAtomic } from './comments.ts';
import type { CliIo } from './index.ts';
import { hostOf, postStatus, sendReview, sentWhat, type PastedToken } from './post.ts';
import type { Progress } from './progress.ts';

/** What tests get instead of waiting for Ctrl+C. */
export interface ServeHandle {
  url: string;
  stop(): Promise<void>;
}

const MAX_BODY = 32 * 1024 * 1024;

// The page is Bowi's own single file: inline script and styles, no requests but to this server.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

const FORBIDDEN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Bowi</title><p>This address needs the link that <code>bowi serve</code> printed in the terminal. Open that link instead.</p>\n';

export async function serveReport(
  dir: string,
  io: CliIo,
  progress: Progress,
  options: { open: boolean; openUrl: (url: string) => void },
): Promise<number> {
  const plan = await readReport(dir);
  const htmlPath = join(dir, HTML_FILE);
  const html = await readFile(htmlPath, 'utf8').catch(() => {
    throw new UsageError(
      `${dir} has no ${HTML_FILE} (written with --json-only?).`,
      `Run bowi again with --out ${dir} and without --json-only.`,
    );
  });
  if (!supportsComments(html)) {
    throw new UsageError(
      `${htmlPath} was written by an older Bowi, which had no comments.`,
      `Run bowi again with --out ${dir} to update the report, then serve it.`,
    );
  }

  const token = randomBytes(18).toString('base64url');
  const tokenOk = (given: unknown) => {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // A token pasted in the post dialog: in memory, until this server stops (§15 #73).
  let pasted: PastedToken | undefined;
  // Saves one at a time, so two quick saves never interleave their writes.
  let queue: Promise<unknown> = Promise.resolve();
  let hosts = new Set<string>();

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!hosts.has(host)) return send(res, 403, 'text/plain; charset=utf-8', 'Unknown host.\n');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      return send(
        res,
        403,
        'text/plain; charset=utf-8',
        'Requests from other pages are refused.\n',
      );
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/' || url.pathname === `/${HTML_FILE}`) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return sendJson(res, 405, { error: 'method' });
      if (!tokenOk(url.searchParams.get('t'))) {
        return send(res, 403, 'text/html; charset=utf-8', FORBIDDEN_PAGE, PAGE_HEADERS);
      }
      const page = await readFile(htmlPath);
      return send(res, 200, 'text/html; charset=utf-8', page, PAGE_HEADERS);
    }
    const api = ['/api/review', '/api/review/posted', '/api/github', '/api/github/token'];
    if (!api.includes(url.pathname)) return sendJson(res, 404, { error: 'not found' });
    if (!tokenOk(req.headers['x-bowi-token'])) return sendJson(res, 403, { error: 'token' });
    if (url.pathname === '/api/github') return github(req, res);
    if (url.pathname === '/api/github/token') return useToken(req, res);
    if (url.pathname === '/api/review/posted') return posted(req, res);

    if (req.method === 'GET') {
      const current = await readReport(dir);
      return sendJson(res, 200, {
        generatedAt: current.generatedAt,
        headSha: current.source.headSha,
        review: current.review ?? emptyReview(),
        dir,
      });
    }
    if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'Send JSON.' });
    }
    const body = await readBody(req);
    if (body === undefined) return sendJson(res, 413, { error: 'Too large.' });
    let input: { generatedAt?: unknown; review?: unknown };
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return sendJson(res, 400, { error: 'Not JSON.' });
    }
    const parsed = parseReview(input.review);
    if ('error' in parsed) return sendJson(res, 400, { error: parsed.error });

    const saved = (queue = queue.then(async () => {
      const current = await readReport(dir);
      // A run wrote a new report into the folder since the page loaded: its anchors are stale.
      if (current.generatedAt !== input.generatedAt) return 'stale' as const;
      // What went to GitHub is read-only, whatever this save says about it.
      const next = keepSent(current.review ?? emptyReview(), parsed.review);
      if (hasReview(next)) current.review = next;
      else delete current.review;
      await writeFileAtomic(join(dir, PLAN_FILE), planJson(current));
      const page = await readFile(htmlPath, 'utf8');
      await writeFileAtomic(htmlPath, withReview(page, current.review));
      return 'saved' as const;
    }));
    const outcome = await saved;
    if (outcome === 'stale') {
      return sendJson(res, 409, {
        error: 'The report was written again since this page was opened. Reload the page.',
      });
    }
    return sendJson(res, 200, { savedAt: new Date().toISOString() });
  }

  /** "I submitted it" and its Undo (§15 #72): the one change to what was sent, made here only. */
  async function posted(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'Send JSON.' });
    }
    const body = await readBody(req);
    if (body === undefined) return sendJson(res, 413, { error: 'Too large.' });
    let input: Partial<PostedMark> & { generatedAt?: unknown };
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return sendJson(res, 400, { error: 'Not JSON.' });
    }
    const { ids, summary, posted: isPosted } = input;
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === 'string') ||
      typeof summary !== 'boolean' ||
      typeof isPosted !== 'boolean'
    ) {
      return sendJson(res, 400, { error: 'Not a mark.' });
    }
    const marking = queue.then(async () => {
      const current = await readReport(dir);
      if (current.generatedAt !== input.generatedAt || !current.review) return 'stale' as const;
      current.review = setPosted(current.review, { ids, summary, posted: isPosted });
      await writeFileAtomic(join(dir, PLAN_FILE), planJson(current));
      const page = await readFile(htmlPath, 'utf8');
      await writeFileAtomic(htmlPath, withReview(page, current.review));
      return 'saved' as const;
    });
    queue = marking.catch(() => undefined);
    if ((await marking) === 'stale') {
      return sendJson(res, 409, {
        error: 'The report was written again since this page was opened. Reload the page.',
      });
    }
    return sendJson(res, 200, { savedAt: new Date().toISOString() });
  }

  /**
   * "Use another token" (§15 #73): `POST` checks a pasted token with GitHub and, if it works, uses
   * it instead of the login Bowi finds; `DELETE` goes back to that. The token is kept in memory
   * only, never written or printed, and never sent back to the page.
   */
  async function useToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'DELETE') {
      pasted = undefined;
      return sendJson(res, 200, {});
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'Send JSON.' });
    }
    const body = await readBody(req);
    if (body === undefined) return sendJson(res, 413, { error: 'Too large.' });
    let input: { token?: unknown; name?: unknown };
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return sendJson(res, 400, { error: 'Not JSON.' });
    }
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    if (!/^[\x21-\x7e]{1,255}$/.test(token)) {
      return sendJson(res, 400, {
        kind: 'login',
        error: `That does not look like a ${requestWords((await readReport(dir)).source)?.host ?? 'GitHub'} token.`,
        hint: 'Paste the whole token, without spaces.',
      });
    }
    const candidate: PastedToken = { token, ...(name && { name }) };
    try {
      const status = await postStatus(await hostOf(await readReport(dir), io, candidate));
      pasted = candidate;
      return sendJson(res, 200, status);
    } catch (e) {
      if (!(e instanceof HostError) && !(e instanceof UsageError)) throw e;
      const kind = e instanceof HostError ? e.kind : 'other';
      return sendJson(res, 502, { kind, error: e.message, hint: e.hint });
    }
  }

  /** "Post to GitHub" (or GitLab): `GET` what the dialog shows, `POST` to send. Only ever on these requests. */
  async function github(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const failed = (e: unknown) => {
      if (!(e instanceof HostError) && !(e instanceof UsageError)) throw e;
      const kind = e instanceof HostError ? e.kind : 'other';
      return sendJson(res, 502, { kind, error: e.message, hint: e.hint });
    };
    if (req.method === 'GET') {
      try {
        return sendJson(
          res,
          200,
          await postStatus(await hostOf(await readReport(dir), io, pasted)),
        );
      } catch (e) {
        return failed(e);
      }
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'Send JSON.' });
    }
    const body = await readBody(req);
    if (body === undefined) return sendJson(res, 413, { error: 'Too large.' });
    let input: Partial<PostRequest> & { generatedAt?: unknown };
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return sendJson(res, 400, { error: 'Not JSON.' });
    }
    const { mode, commentIds, summary } = input;
    if (
      (mode !== 'pending' && mode !== 'now') ||
      !Array.isArray(commentIds) ||
      !commentIds.every((id) => typeof id === 'string') ||
      typeof summary !== 'boolean'
    ) {
      return sendJson(res, 400, { error: 'Not a post request.' });
    }
    // In the queue: a save from another tab waits, and a second post finds these marked as sent.
    const posting = queue.then(async () => {
      const current = await readReport(dir);
      if (current.generatedAt !== input.generatedAt) return 'stale' as const;
      const access = await hostOf(current, io, pasted);
      const result = await sendReview(dir, { mode, commentIds, summary }, access, io.now);
      return { result, source: current.source };
    });
    queue = posting.catch(() => undefined);
    let outcome: Awaited<typeof posting>;
    try {
      outcome = await posting;
    } catch (e) {
      return failed(e);
    }
    if (outcome === 'stale') {
      return sendJson(res, 409, {
        error: 'The report was written again since this page was opened. Reload the page.',
      });
    }
    const { result, source } = outcome;
    if (result.sent > 0 || result.summarySent) {
      const what = sentWhat(result.sent, result.summarySent);
      const to = `to ${source.repo}#${source.prNumber} as @${result.login}`;
      if (mode === 'pending') progress.line('Sent', `${what} ${to}, as a pending review`);
      else progress.line('Posted', `${what} ${to}`);
    }
    return sendJson(res, 200, result);
  }

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const { port } = server.address() as AddressInfo;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  const n = plan.review?.comments.length ?? 0;
  progress.line('Serving', `${HTML_FILE} · ${n} comment${n === 1 ? '' : 's'} in the plan`);
  progress.done(`Open ${url}`);
  progress.note(`Comments are saved to ${join(dir, PLAN_FILE)} as you write them.`);
  progress.note('Only this computer can open the link. Press Ctrl+C to stop.');
  if (options.open && io.stdout.isTTY) options.openUrl(url);

  const closed = new Promise<void>((ok) => server.once('close', () => ok()));
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  };
  if (io.onServe) io.onServe({ url, stop });
  else {
    const onSignal = () => void stop();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    closed.then(() => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    });
  }
  await closed;
  progress.note('Stopped serving.');
  return 0;
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

/** The request body, or undefined when it is larger than MAX_BODY. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
