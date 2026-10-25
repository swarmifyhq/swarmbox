// The control room: one live tile per open screen, and take-over.
//
// Tiles are Chromium's own screencast (CDP Page.startScreencast). The page polls /state and fetches a
// tile's latest picture (/screens/:id/frame) only when its frame count moved: short requests, because a
// browser opens at most 6 connections to one address, and one never-ending stream per tile used them all,
// so /state stopped getting through and the page froze (16 Oct, with 8 tiles; /stream remains for other
// viewers). Take-over flips the screen's controller in the harness, the same state the MCP tools check,
// so "a person has this screen" is enforced rather than hoped for; while they have it, their clicks,
// wheel and keys on the tile go to that screen's browser (/screens/:id/input).
//
// Loopback only. Every request must carry this server's own Host (stops DNS rebinding, which would
// otherwise let a website read the tiles: they show the product's data), and the one write must come
// from this page's own origin (stops cross-site form posts).

import http from 'node:http';
import type { Socket } from 'node:net';
import type { Harness, PersonInput } from '../harness.ts';
import type { ProductWorld } from '../product.ts';
import { page } from './page.ts';

/** How long a screen may be quiet before its latest frame is re-sent to make the tile show it. */
const REPEAT_MS = 500;

export interface ControlRoom {
  url: string;
  close(): Promise<void>;
}

export async function serveControlRoom<W extends ProductWorld>(
  h: Harness<W>,
  port: number,
): Promise<ControlRoom> {
  const PAGE = page(h.product.title ?? h.product.name);
  let actualPort = port;
  const own = () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    if (!own().includes(req.headers.host ?? '')) {
      res.writeHead(403).end('wrong host');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(PAGE);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      const state = {
        worlds: h.worlds().map((w) => ({
          id: w.id,
          port: w.world.port,
          tenants: w.world.tenants.map((t) => ({ slug: t, origin: w.world.origin(t) })),
        })),
        screens: h.screens().map((s) => ({
          id: s.id,
          world: s.worldId,
          tenant: s.persona.tenant,
          person: s.persona.label,
          controller: s.controller,
          url: s.screen.page.url(),
          frameSeq: s.frameSeq,
        })),
      };
      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(state));
      return;
    }

    const frame = url.pathname.match(/^\/screens\/(s\d+)\/frame$/);
    if (req.method === 'GET' && frame) {
      const entry = h.screens().find((s) => s.id === frame[1]);
      if (!entry?.frame) {
        res.writeHead(entry ? 204 : 404).end();
        return;
      }
      res
        .writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'no-store',
          'x-frame-seq': String(entry.frameSeq),
        })
        .end(entry.frame);
      return;
    }

    const stream = url.pathname.match(/^\/screens\/(s\d+)\/stream$/);
    if (req.method === 'GET' && stream) {
      const entry = h.screens().find((s) => s.id === stream[1]);
      if (!entry) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=frame',
        'cache-control': 'no-store',
        connection: 'close',
      });
      // Chromium shows a part of a multipart image only once the NEXT part arrives. The screencast emits
      // only when the page changes, so a quiet screen would leave its tile blank, or a step behind, until
      // something else happened on it. So when a screen has been quiet for a moment its latest frame is
      // sent again, which pushes the previous one onto the tile.
      res.write('--frame\r\n');
      let last = 0;
      const send = (jpeg: Buffer) => {
        last = Date.now();
        res.write(`Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n--frame\r\n');
      };
      if (entry.frame) send(entry.frame);
      const repeat = setInterval(() => {
        if (entry.frame && Date.now() - last >= REPEAT_MS) send(entry.frame);
      }, REPEAT_MS);
      entry.watchers.add(send);
      req.on('close', () => {
        clearInterval(repeat);
        entry.watchers.delete(send);
      });
      return;
    }

    const sameOrigin = () => {
      const origin = req.headers.origin;
      if (
        origin &&
        own()
          .map((x) => `http://${x}`)
          .includes(origin)
      )
        return true;
      res.writeHead(403).end('wrong origin');
      return false;
    };

    const input = url.pathname.match(/^\/screens\/(s\d+)\/input$/);
    if (req.method === 'POST' && input) {
      if (!sameOrigin()) return;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end('json please');
          return;
        }
        h.personInput(input[1]!, parsed as PersonInput).then(
          () => res.writeHead(204).end(),
          (e: Error) => res.writeHead(409).end(e.message),
        );
      });
      return;
    }

    const control = url.pathname.match(/^\/screens\/(s\d+)\/control$/);
    if (req.method === 'POST' && control) {
      if (!sameOrigin()) return;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const to = (() => {
          try {
            return (JSON.parse(body) as { controller?: string }).controller;
          } catch {
            return undefined;
          }
        })();
        if (to !== 'person' && to !== 'agent') {
          res.writeHead(400).end('controller must be person or agent');
          return;
        }
        h.setController(control[1]!, to).then(
          () => res.writeHead(204).end(),
          (e: Error) => res.writeHead(404).end(e.message),
        );
      });
      return;
    }

    res.writeHead(404).end();
  });
  // MJPEG responses never end on their own; track sockets so close() does not wait forever.
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  actualPort = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
