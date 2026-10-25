// The agent's tools for a screen's device and the props a person makes or carries (docs/standins.md, The device
// and props).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Harness } from '../harness.ts';
import type { Prop } from '../device/props.ts';
import type { ProductWorld } from '../product.ts';

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const describe = (p: Prop) =>
  `${p.id}: ${p.kind}, "${p.about}" (${p.name}, ${p.mime}, ${Math.round(p.bytes / 1024)} KB; tagged ${p.tag} inside the file)`;

export function registerDeviceTools<W extends ProductWorld>(
  server: McpServer,
  h: Harness<W>,
  guard: (fn: () => Promise<CallToolResult>) => Promise<CallToolResult>,
): void {
  server.registerTool(
    'prop_make',
    {
      title: 'Make a photo, a document or a signature',
      description:
        'Make a prop a person would carry or create: a photo ("a water heater, rusted at the base"), a document ' +
        '(a vendor’s bill, a permit: a PDF) or a signature (a PNG). It is drawn by Swarmbox, never a real file, and ' +
        'tagged with its id inside the file and in a corner, so a check can tell later which one arrived where. ' +
        'Then give it to a screen with file_pick (an upload, or a phone’s or tablet’s camera button) or camera_show.',
      inputSchema: {
        kind: z.enum(['photo', 'document', 'signature']),
        about: z.string().min(1).max(300).describe('What it shows or says'),
      },
    },
    async ({ kind, about }) => guard(async () => text(describe(await h.makeProp(kind, about)))),
  );

  server.registerTool(
    'prop_list',
    {
      title: 'List the props made so far',
      description: 'Every prop made in this session, with its id, kind, file and tag.',
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => text(h.props().map(describe).join('\n') || 'no props yet')),
  );

  server.registerTool(
    'file_pick',
    {
      title: 'Put a prop in the next file chooser',
      description:
        'The next file chooser on the screen picks this prop, as a person choosing a file or taking a picture ' +
        'would. On a phone or tablet the camera button usually opens one. Queue several for several choosers. ' +
        'A chooser that opens with nothing queued is noted on the screen, and stays open, as it would for a person.',
      inputSchema: { screen: z.string(), prop: z.string() },
    },
    async ({ screen, prop }) =>
      guard(async () => text(`queued for ${screen}: ${describe(h.pickFile(screen, prop))}`)),
  );

  server.registerTool(
    'camera_show',
    {
      title: 'Put a prop in front of the camera',
      description:
        'What the screen’s camera sees, for an app that opens a live camera: the prop, held still, until changed. ' +
        'No prop: the camera shows a plain grey frame.',
      inputSchema: { screen: z.string(), prop: z.string().optional() },
    },
    async ({ screen, prop }) =>
      guard(async () => {
        await h.showCamera(screen, prop ?? null);
        return text(prop ? `${screen}'s camera shows ${prop}` : `${screen}'s camera shows nothing`);
      }),
  );

  server.registerTool(
    'location_set',
    {
      title: 'Where the device is',
      description: 'Put the screen’s device at a place, and allow it to say where it is.',
      inputSchema: {
        screen: z.string(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      },
    },
    async ({ screen, lat, lng }) =>
      guard(async () => {
        await h.setLocation(screen, lat, lng);
        return text(`${screen} is at ${lat}, ${lng}`);
      }),
  );

  server.registerTool(
    'notifications_set',
    {
      title: 'Whether the device shows notifications',
      description:
        'Allow or refuse notifications on the screen’s device. This resets its other permissions to the defaults ' +
        '(the camera stays allowed), so set the location again after.',
      inputSchema: { screen: z.string(), allow: z.boolean() },
    },
    async ({ screen, allow }) =>
      guard(async () => {
        await h.setNotifications(screen, allow);
        return text(`${screen}: notifications ${allow ? 'allowed' : 'refused'}`);
      }),
  );
}
