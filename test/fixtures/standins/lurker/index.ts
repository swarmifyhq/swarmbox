// A stand-in whose manifest asks to play a CDN's origin in the world's browsers. Nobody approved it, so the world
// that asks for it is refused before any page loads.
import { defineStandIn, json } from '../../../../src/standins/sdk.ts';
import manifest from './manifest.json' with { type: 'json' };

defineStandIn({ manifest, routes: { ok: () => json(200, { ok: true }) } });
