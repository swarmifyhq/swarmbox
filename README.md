# Swarmbox

A sandbox where AI agents use your product the way people do: in real browsers, against a throwaway copy of
it (a _world_), as each of your roles at once. The agent sees what a person sees and what the server did,
logs what isn't right, and ends with your checks and a report anyone can read.

Part of [Swarmify](https://github.com/swarmifyhq/swarmify). Private for now.

## What it gives an agent

- **Sight.** Open dialogs come first and whole when it reads a screen. Every action reports what changed
  (a dialog opened or closed, a status line, the address), what the server did (its own command and what
  that set off, and anything that failed or was refused), and requests refused. A click that can't land
  says what is in the way; of two buttons with one name, the one in the dialog in front is meant.
- **Worlds.** Each run starts your product the way it is deployed, with its own data, on tenant hosts that
  resolve only inside the browsers Swarmbox launches. Nothing is shared with other runs or with real data.
- **People.** Everyone in the world, signed in without a password, each on their own screen; a tablet
  app past its first screen; a customer at a link, with no sign-in at all.
- **Runs.** A scenario in plain words (what to try, what good looks like, who is on screen), findings with
  screenshots, Playwright traces of every screen, your checks at the end, and one HTML report.
- **A control room** at http://127.0.0.1:3100: every screen live, and take-over, during which the agent's
  actions on that screen are refused.
- **A daily budget** in browser-minutes and runs.

## Plugging a product in

A product is one object (`Product` in `src/product.ts`): how to start a world, who is in it, how each of
them signs in, and how to check the world afterwards. Then:

```ts
import { serve } from '@swarmifyhq/swarmbox';
import { myProduct } from './product.ts';

await serve(myProduct());
```

```sh
claude mcp add --transport http swarmbox-myproduct http://127.0.0.1:3101/mcp
```

`test/fixtures/sample-product.ts` is a complete product in about 200 lines.

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
pnpm exec playwright install chromium
pnpm run test:browser   # everything, the browser tests too
```

Node 24. The source runs as TypeScript in tests; the package ships `dist/` (`pnpm run build`).
