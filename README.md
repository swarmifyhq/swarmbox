# Swarmbox

A sandbox where AI agents use your product the way people do: in real browsers, against a throwaway copy of
it (a _world_), as each of your roles at once. The agent sees what a person sees and what the server did,
logs what isn't right, and ends with your checks and a report anyone can read.

Built for Swarmify's agents, and usable by any team whose product runs locally. MIT licensed.

## What it gives an agent

- **Sight.** Open dialogs come first and whole when it reads a screen. Every action reports what changed
  (a dialog opened or closed, a status line, the address), what the server did (its own command and what
  that set off, and anything that failed or was refused), and requests refused. A click that can't land
  says what is in the way; of two buttons with one name, the one in the dialog in front is meant.
- **Worlds.** Each run starts your product the way it is deployed, with its own data, on tenant hosts that
  resolve only inside the browsers Swarmbox launches. Nothing is shared with other runs or with real data.
  Name what your pages load from outside (`browserAllow`: fonts, maps), or say `contain: true`, and a world's
  browsers reach only the world, its stand-ins and those; anything else is blocked and shows as a signal.
  Without either they can reach anything this machine can, and `world_list` says so: if your app knows a real
  outside address (an identity provider, an API), contain it.
- **People.** Everyone in the world, signed in without a password, each on their own screen; a tablet
  app past its first screen; a customer at a link, with no sign-in at all. Any screen can be a phone, a
  tablet either way up or a desktop, light or dark.
- **The device and props.** Swarmbox makes the photos, documents and signatures a person would use, each tagged
  with its id. It puts them in a screen's file chooser (a tablet's camera button) or in front of its live camera,
  and sets where the device is and whether it shows notifications.
- **Hands on the screen.** Click, type, choose, press keys, scroll, draw (a signature pad) and drag with the pointer
  (a block onto another lane, an edge to resize, a box onto a page below the fold, scrolling on the way), each
  element found by its accessible role and name. A styled
  radio or checkbox is clicked through the label drawn over it, and of two alike in stacked layers, the one in
  front is taken.
- **Time.** Move a world's clock forward, and every screen follows; people stay signed in across the jump
  (`renewSignIn`). A kept world that comes back with its clock moved on an earlier run starts its screens on its
  own time. A scenario can say when its day starts (`world.startsAt`: "09:00", or a date and time
  in the tenant's zone, to test across a time change). Swarmbox works out times with Node's tzdata; a
  screen shows them with Chromium's own, and the two can differ on a zone whose rules changed recently.
  A time a screen shows an hour out may be that, not your product.
- **Runs.** A scenario in plain words (what to try, what good looks like, who is on screen), findings with
  screenshots, Playwright traces of every screen, your checks at the end, and one HTML report.
- **A control room** at http://127.0.0.1:3100: every screen live, and take-over, during which the agent's
  actions on that screen are refused.
- **The world's own log** (`world_log`), when the product shares it: the stack behind a screen's
  "something went wrong", while the world runs.
- **A screen's own requests** (`screen_requests`): what it asked its servers for, with status, timing, and the
  start of what was sent and what came back, and what it keeps open (a live stream). An action's "refused:" line
  gives each refusal's number, with the server's reason (`error.message`, or FastAPI's `detail`). No headers are
  kept, and secrets in addresses and bodies are redacted.
- **A daily budget** in browser-minutes and runs.

## Install

```sh
pnpm add -D swarmbox playwright-core
pnpm exec playwright-core install chromium
```

`playwright-core` is a peer dependency, so your product and Swarmbox share one copy. Node 24 or later.

## Plugging a product in

A product is one object (`Product` in `src/product.ts`): how to start a world, who is in it, how each of
them signs in, and how to check the world afterwards. Then:

```ts
import { serve } from 'swarmbox';
import { myProduct } from './product.ts';

await serve(myProduct());
```

```sh
claude mcp add --transport http swarmbox-myproduct http://127.0.0.1:3101/mcp
```

`test/fixtures/sample-product.ts` is a complete product in about 200 lines.

A product can take options of its own for a world (`worldOptions`, as zod fields): a tenant still
migrating from another system, a feature switched on. `world_create` takes them as `options` and a
scenario as `world.options`.

What adapters have learnt so far:

- **Mint sessions on the world's time.** A world's clock can be days ahead of the machine's, so a session dated on
  the machine's clock may already be over to the product. Date it from the product's own clock (its hooks).
- **Renew by extending, not replacing** (`renewSignIn`). An open page often keeps something derived from its
  session (a CSRF token); a fresh session under it ends in the product's "sign in again".
- **Share the server's output** (`log`): `world_log` is how an agent gets from a screen's "something went wrong" to
  the stack.
- **In the product's own tests, check for the tools it relies on, not Swarmbox's whole list**: each release adds
  tools.
- **Give each of the product's system tests its own port**, apart from the one a running sandbox uses.

### In production

A product that uses stand-ins calls the guard as it starts in production, before it builds any provider client:

```ts
import { assertNoStandins } from 'swarmbox';

if (process.env.NODE_ENV === 'production') assertNoStandins(process.env, { allowLoopback: ['METRICS_URL'] });
```

It refuses to start with anything a stand-in issued (marked keys, fictional 555-01xx numbers), a provider address on
this machine however it's written, or Swarmbox's local certificate authority. It names the variable, never its
value. `allowLoopback` lists variables that really do point at this machine in production.

### Hooks

A product can serve Swarmbox's hooks (protocol v0, `src/hooks.ts`) in its sandbox worlds: a feed of what the
server did, the clock, the phone inbox, and fake providers with rules (fail the next text, a customer
replying). Without them Swarmbox still drives the screens; with them the agent sees the `server:` lines
after each action and can move time.

## Developing

```sh
pnpm install
pnpm run check          # typecheck, lint, formatting
pnpm test               # unit tests
pnpm exec playwright-core install chromium
pnpm run test:browser   # everything, the browser tests too
```

Node 24. The source runs as TypeScript in tests; the package ships `dist/` (`pnpm run build`).

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and [SECURITY.md](SECURITY.md) to report a
security problem.

## Licence

[MIT](LICENSE).
