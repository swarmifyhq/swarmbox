// What serve asks of the stand-in sandbox: a product started through serve on a machine without one (Linux
// without bubblewrap) can say so, by option or by SWARMBOX_NO_SANDBOX=1.

import { describe, expect, it } from 'vitest';
import { standinSandboxFor } from '../../src/serve.ts';

describe('the stand-in sandbox serve asks for', () => {
  it('is required unless told otherwise', () => {
    expect(standinSandboxFor(undefined, {})).toBe('required');
    expect(standinSandboxFor(undefined, { SWARMBOX_NO_SANDBOX: '0' })).toBe('required');
    expect(standinSandboxFor(undefined, { SWARMBOX_NO_SANDBOX: 'yes' })).toBe('required');
  });

  it('is off when the environment says SWARMBOX_NO_SANDBOX=1', () => {
    expect(standinSandboxFor(undefined, { SWARMBOX_NO_SANDBOX: '1' })).toBe('off');
  });

  it('follows the option over the environment, either way', () => {
    expect(standinSandboxFor('off', {})).toBe('off');
    expect(standinSandboxFor('required', { SWARMBOX_NO_SANDBOX: '1' })).toBe('required');
  });
});
