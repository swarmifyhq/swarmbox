// Two things an action reports, without a world: where a link goes (products write links without the
// world's port), and which of the server's feed rows an agent is told about. The rows are from a real run:
// the office sends an estimate, and a second later the text fails for want of a provider.

import { describe, expect, it } from 'vitest';
import { feedLine, HarnessError, linkPath, type LinkWorld } from '../../src/harness.ts';
import type { FeedItem } from '../../src/hooks.ts';
import type { Persona } from '../../src/product.ts';

const BASE = 'example.test';
/** As a product whose customer links name their tenant in /p/<tenant>/. */
const world = (tenants: string[]): LinkWorld => ({
  baseDomain: BASE,
  tenants,
  tenantOfPath: (path) => /^\/p\/([a-z0-9-]+)\//.exec(path)?.[1],
});
const TOKEN = 'o0jwDRdnRsIZIfTJ5XXhkEj3MfoZfiiahWdhD0snU7U';

describe('a link on a tenant’s host', () => {
  it('takes the full link as the product writes it, without the world’s port', () => {
    expect(linkPath(`http://demo-co.${BASE}/p/demo-co/e/${TOKEN}`, world(['demo-co']))).toEqual({
      tenant: 'demo-co',
      path: `/p/demo-co/e/${TOKEN}`,
    });
  });

  it('takes it with the port too, and keeps a query and hash', () => {
    expect(linkPath(`http://demo-co.${BASE}:3094/p/demo-co/i/x?y=1#z`, world(['demo-co'])).path).toBe(
      '/p/demo-co/i/x?y=1#z',
    );
  });

  it('finds the tenant in a bare customer path, or the only tenant there is', () => {
    expect(linkPath(`/p/acme/e/${TOKEN}`, world(['demo-co', 'acme'])).tenant).toBe('acme');
    expect(linkPath('/#/board', world(['demo-co']))).toEqual({ tenant: 'demo-co', path: '/#/board' });
  });

  it('refuses another host, another tenant’s link on this screen, and a path that names no tenant', () => {
    expect(() => linkPath('https://evil.example/p/demo-co/e/x', world(['demo-co']))).toThrow(HarnessError);
    expect(() => linkPath(`http://acme.${BASE}/p/acme/e/x`, world(['demo-co', 'acme']), 'demo-co')).toThrow(
      /acme’s; this screen is on demo-co’s/,
    );
    expect(() => linkPath('/#/board', world(['demo-co', 'acme']))).toThrow(/say which tenant/);
    expect(() => linkPath('board', world(['demo-co']))).toThrow(/starts with \//);
  });

  it('speaks the product’s word for a tenant, and takes a bare path only with one tenant when it can’t tell', () => {
    const plain: LinkWorld = { baseDomain: BASE, tenants: ['demo-co', 'acme'] };
    expect(() => linkPath(`/p/acme/e/${TOKEN}`, plain, undefined, 'company')).toThrow(/say which company/);
    expect(() => linkPath(`http://nope.${BASE}/`, plain, undefined, 'company')).toThrow(/no company nope/);
  });
});

const jamie = { id: 'm-jamie', tenant: 'demo-co' } as Persona;
const office = { customer: false, persona: jamie };
const row = (kind: string, body: Record<string, unknown>): FeedItem => ({
  cursor: '1:1',
  kind,
  at: '2026-10-24T17:53:10Z',
  ...body,
});

describe('what the server did, for this screen', () => {
  const sent = row('action', {
    name: 'estimates.send',
    actionKind: 'command',
    outcome: 'ok',
    principal: { kind: 'user', membershipId: 'm-jamie' },
    nested: ['messages.send'],
  });
  const failed = row('action', {
    name: 'messages.recordFailed',
    actionKind: 'command',
    outcome: 'ok',
    principal: { kind: 'system', handler: 'messaging.send' },
    input: { id: 'x', code: 'no_provider', message: 'No text-message provider is set up for this company.' },
  });

  it('tells it its own command and what it set off, then the text that failed after', () => {
    expect(feedLine(sent, office)).toBe('you: estimates.send ok → messages.send');
    expect(feedLine(failed, office)).toBe(
      'the system: messages.recordFailed ok — no_provider: No text-message provider is set up for this company.',
    );
  });

  it('tells it a refusal anywhere, and a delivery that failed or died', () => {
    expect(
      feedLine(
        row('action', {
          name: 'jobs.complete',
          outcome: 'rejected',
          errorCode: 'validation',
          principal: { kind: 'user', membershipId: 'm-other' },
        }),
        office,
      ),
    ).toBe('someone else: jobs.complete rejected (validation)');
    expect(
      feedLine(
        row('delivery', {
          type: 'estimate.sent',
          handler: 'agents.copilotTriggers',
          status: 'dead',
          error: 'boom',
        }),
        office,
      ),
    ).toBe('the worker: agents.copilotTriggers on estimate.sent dead — boom');
  });

  it('leaves out what went fine for others, queries, deliveries done, and other kinds of row', () => {
    const others = { ...sent, principal: { kind: 'user', membershipId: 'm-other' } };
    expect(feedLine(others, office)).toBeNull();
    expect(feedLine({ ...sent, actionKind: 'query' }, office)).toBeNull();
    expect(feedLine(row('delivery', { status: 'done', handler: 'h', type: 't' }), office)).toBeNull();
    expect(feedLine(row('sync', { op: 'pull' }), office)).toBeNull();
    expect(feedLine(row('event', { type: 'estimate.sent' }), office)).toBeNull();
  });

  it('counts the customer’s own portal actions as theirs on a customer’s screen', () => {
    const signed = row('action', {
      name: 'portal.estimate.sign',
      outcome: 'ok',
      principal: { kind: 'customer', id: 'c1', resource: 'estimate' },
    });
    expect(feedLine(signed, { customer: true, persona: { ...jamie, id: '' } })).toBe(
      'you: portal.estimate.sign ok',
    );
    expect(feedLine(signed, office)).toBeNull();
  });
});
