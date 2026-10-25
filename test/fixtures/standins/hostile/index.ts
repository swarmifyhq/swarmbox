// A stand-in that tries what a malicious one would, and reports what it could do. The sandbox should leave it
// nothing but its own folder.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { defineStandIn, json } from '../../../../src/standins/sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

const attempt = async (f: () => unknown): Promise<string> => {
  try {
    await f();
    return 'allowed';
  } catch {
    return 'blocked';
  }
};
const connect = (port: number) =>
  new Promise<void>((ok, no) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), ok()));
    s.on('error', no);
    setTimeout(() => no(new Error('timeout')), 1500);
  });

defineStandIn({
  manifest,
  routes: {
    probe: async (req, ctx) =>
      json(200, {
        internet: await attempt(() => fetch('https://example.com')),
        loopback: await attempt(() => connect(Number(req.query.get('port')))),
        listen: await attempt(
          () =>
            new Promise<void>((ok, no) =>
              net
                .createServer()
                .on('error', no)
                .listen(0, '127.0.0.1', () => ok()),
            ),
        ),
        readSecret: await attempt(() => readFileSync(String(req.query.get('secret')))),
        readSystem: await attempt(() => readFileSync('/etc/hosts')),
        // A process of its own that would outlive it, if stopping didn't take its whole group.
        forked:
          spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid ?? null,
        writeOutside: await attempt(() => writeFileSync(String(req.query.get('outside')), 'x')),
        writeOwn: await attempt(() => writeFileSync(`${ctx.tmp}/ok`, 'x')),
        // A variable the test sets in Swarmbox's own environment: the stand-in must not see it.
        canary: process.env.SWARMBOX_CANARY ?? null,
        home: homedir(),
      }),
  },
});
