// The device a screen runs on (docs/standins.md, The device and props): its camera, the files it can pick, where it
// is and whether it shows notifications. Network, clock, shape and appearance are set elsewhere (harness.ts,
// fleet/browser.ts); this is the part a person reaches with their hands.

import { readFileSync } from 'node:fs';
import type { BrowserContext, FileChooser, Page } from 'playwright-core';
import type { Prop } from './props.ts';

export interface DeviceState {
  /** Props queued for the next file choosers, first first. */
  files: Prop[];
  /** What the camera shows now, if anything. */
  camera: Prop | null;
}

/**
 * Inside every page: the camera is a canvas that draws whatever Swarmbox last put in front of it (a grey frame
 * until then), so an app asking for the camera gets a working one with no prompt and no real device.
 */
function cameraInPage(): void {
  const md = navigator.mediaDevices;
  if (!md) return;
  const w = window as unknown as {
    __swarmboxCamera?: string | null;
    __swarmboxSetCamera?: (u: string | null) => void;
  };
  w.__swarmboxCamera ??= null;
  w.__swarmboxSetCamera = (url) => {
    w.__swarmboxCamera = url;
  };
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (!constraints?.video)
      throw new DOMException('This device has no microphone in a Swarmbox world', 'NotFoundError');
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 960;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    let shown: string | null = null;
    const draw = () => {
      const url = w.__swarmboxCamera ?? null;
      if (url !== shown) {
        shown = url;
        if (url) img.src = url;
      }
      if (url && img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      else {
        ctx.fillStyle = '#444';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    };
    draw();
    setInterval(draw, 66);
    return canvas.captureStream(15);
  };
  md.enumerateDevices = async () =>
    [
      {
        deviceId: 'swarmbox-camera',
        groupId: 'swarmbox',
        kind: 'videoinput',
        label: 'Swarmbox camera',
        toJSON: () => ({}),
      },
    ] as MediaDeviceInfo[];
}

const dataUrl = (prop: Prop): string =>
  `data:${prop.mime};base64,${readFileSync(prop.file).toString('base64')}`;

/**
 * Set a new screen's device up, before its first page: the camera allowed and stood in for, and every file
 * chooser answered from the queue, or noted when nothing was queued.
 */
export async function setUpDevice(
  context: BrowserContext,
  state: DeviceState,
  note: (text: string) => void,
): Promise<void> {
  await context.grantPermissions(['camera', 'microphone']);
  await context.addInitScript(cameraInPage);
  const answer = async (chooser: FileChooser) => {
    const prop = state.files.shift();
    if (!prop) {
      note('a file chooser opened and nothing was picked: file_pick puts a prop in it');
      return;
    }
    await chooser.setFiles({ name: prop.name, mimeType: prop.mime, buffer: readFileSync(prop.file) });
    note(`picked ${prop.id} (${prop.kind}: ${prop.about}) in a file chooser`);
  };
  const watch = (page: Page) =>
    page.on('filechooser', (c) => void answer(c).catch((e: Error) => note(`could not pick: ${e.message}`)));
  context.on('page', watch);
  for (const page of context.pages()) watch(page);
}

/** Put a prop in front of the camera (null: nothing), in the open pages and in any the screen opens next. */
export async function showOnCamera(
  context: BrowserContext,
  state: DeviceState,
  prop: Prop | null,
): Promise<void> {
  state.camera = prop;
  const url = prop ? dataUrl(prop) : null;
  await context.addInitScript((u: string | null) => {
    (window as unknown as { __swarmboxCamera?: string | null }).__swarmboxCamera = u;
  }, url);
  for (const page of context.pages())
    await page
      .evaluate(
        (u: string | null) =>
          (window as unknown as { __swarmboxSetCamera?: (x: string | null) => void }).__swarmboxSetCamera?.(
            u,
          ),
        url,
      )
      .catch(() => undefined);
}

export async function setLocation(
  context: BrowserContext,
  latitude: number,
  longitude: number,
  accuracy = 20,
): Promise<void> {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude, longitude, accuracy });
}

export async function setNotifications(context: BrowserContext, allow: boolean): Promise<void> {
  // Permissions can only be cleared all at once, so the camera's go back with them.
  await context.clearPermissions();
  await context.grantPermissions(
    allow ? ['camera', 'microphone', 'notifications'] : ['camera', 'microphone'],
  );
}
