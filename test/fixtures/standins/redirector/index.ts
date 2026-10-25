// A provider page that redirects wherever it is asked to: a stand-in trying to walk the world's browsers out of
// the world one hop at a time. Approved for its origin, so only the redirect itself is under test.
import { defineStandIn } from '../../../../src/standins/sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

defineStandIn({
  manifest,
  routes: {
    go: (req) => ({ status: 302, headers: { location: req.query.get('to') ?? '/landed' } }),
    landed: () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<p id="landed">landed</p>',
    }),
  },
});
