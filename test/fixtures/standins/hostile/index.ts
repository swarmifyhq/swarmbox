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

let listening: number | null = null;

defineStandIn({
  manifest,
  routes: {
    probe: async (req, ctx) =>
      json(200, {
        internet: await attempt(() => fetch('https://example.com')),
        loopback: await attempt(() => connect(Number(req.query.get('port')))),
        listen: await attempt(
          () =>
            new Promise<void>((ok, no) => {
              const server = net.createServer().on('error', no);
              server.listen(0, '127.0.0.1', () => {
                listening = (server.address() as net.AddressInfo).port;
                ok();
              });
            }),
        ),
        // Where it listens, if it could: the test checks nothing outside the sandbox can reach it.
        listening,
        readSecret: await attempt(() => readFileSync(String(req.query.get('secret')))),
        readSystem: await attempt(() => readFileSync('/etc/hosts')),
        // A process of its own in its own session, which would outlive a group kill. Denied in the sandbox on
        // macOS; anywhere it starts, stopping the stand-in must still take it.
        forked: await new Promise((done) => {
          try {
            // The test's marker rides in its arguments: found from the host, whatever pid a sandbox gives it.
            const marker = String(req.query.get('marker') ?? 'swarmbox-fork');
            const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], {
              stdio: 'ignore',
              detached: true,
            });
            c.on('error', () => done(null));
            c.on('spawn', () => done(c.pid ?? null));
          } catch {
            done(null); // the sandbox refused it outright
          }
        }),
        writeOutside: await attempt(() => writeFileSync(String(req.query.get('outside')), 'x')),
        writeOwn: await attempt(() => writeFileSync(`${ctx.tmp}/ok`, 'x')),
        // A variable the test sets in Swarmbox's own environment: the stand-in must not see it.
        canary: process.env.SWARMBOX_CANARY ?? null,
        home: homedir(),
      }),
  },
});
