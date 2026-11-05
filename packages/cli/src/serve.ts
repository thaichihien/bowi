/**
 * `bowi serve <dir>` and `--serve` on a run (CLI-13, M10): serves a report on this computer so
 * its page can save comments into review-plan.json. A page opened as a file cannot write files.
 *
 * Only 127.0.0.1, on a free port, with a random token every request must carry: in the address
 * (`?t=`) for the page, in the `X-Bowi-Token` header for the API, so no other page in the browser
 * can read or write. The `Host` header must name this server and an `Origin`, when sent, the
 * page's own, which shuts out DNS rebinding. The only thing it writes is the review of this one
 * folder; it makes no requests of its own (NFR-3).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { emptyReview, hasReview, parseReview, UsageError } from '@bowi/core';
import { supportsComments, withReview } from '@bowi/render-html';
import { HTML_FILE, PLAN_FILE, planJson, readReport, writeFileAtomic } from './comments.ts';
import type { CliIo } from './index.ts';
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
    if (url.pathname !== '/api/review') return sendJson(res, 404, { error: 'not found' });
    if (!tokenOk(req.headers['x-bowi-token'])) return sendJson(res, 403, { error: 'token' });

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
      if (hasReview(parsed.review)) current.review = parsed.review;
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
