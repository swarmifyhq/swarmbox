// A process with a world's browser open whose own Ctrl-C handler takes a while: what serve() is when a world is
// slow to stop. It writes `done` to the file it's given only if nothing exits the process first.
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launchFleet } from '../../src/fleet/browser.ts';

const out = process.argv[2]!;
const site = http.createServer((_q, res) => res.end('<!doctype html><title>t</title><main>hi</main>'));
await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
const port = (site.address() as AddressInfo).port;
const fleet = await launchFleet({ baseDomain: 'sig.test', port, headless: true });
await fleet.open({ persona: { tenant: 't', timeZone: 'UTC' }, signIn: null }, '/');
process.on('SIGINT', () => {
  setTimeout(() => {
    writeFileSync(out, 'done');
    void fleet.close().then(() => process.exit(0));
  }, 1500);
});
process.stdout.write('ready\n');
