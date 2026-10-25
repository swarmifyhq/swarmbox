# Contributing to Swarmbox

Thanks for helping. Bug reports, fixes and new product adapters are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first and say what you want to change and why, so
  we can agree on the shape before you write it.
- Swarmbox knows nothing about any one product. What is general (screens, worlds, runs, checks, the
  clock) lives here; what is a product's (how it starts, who signs in, its checks) lives in that
  product's `Product` adapter. If a change only makes sense for one product, it belongs in its adapter.

## Setting up

```sh
pnpm install
pnpm exec playwright-core install chromium
pnpm run check          # typecheck, lint, formatting
pnpm test               # unit tests, no browser
pnpm run test:browser   # everything, with Chromium
```

Node 24. `test/fixtures/sample-product.ts` is a complete product in about 200 lines: the quickest way to
see how a product plugs in, and what the browser tests run against.

## Sending a change

- Branch from `staging` and open the pull request against `staging`. `main` is what is published.
- Every change comes with a test that fails without it. Browser behaviour is tested through the MCP tools
  against the sample product, as `test/harness.test.ts` does.
- `pnpm run check` and the tests pass locally before you push.
- Formatting is Prettier's (`pnpm exec prettier --write .`); lint is ESLint with typescript-eslint.
- Keep comments to why, not what. Plain words in tool descriptions: an agent reads them.
- Bump the version in `package.json` when the change is something a product would install for.

## Reporting a bug

Say what you ran, what you expected and what happened, with the tool's output. A run's report folder
(its HTML report and traces) helps most. Never attach real customer data or secrets: worlds hold only
invented data, and that is the only kind a report should carry.
