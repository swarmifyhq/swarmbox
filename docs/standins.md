# Stand-ins: the contract

A product under test talks to the outside world: payments, texts and calls, email, file storage, push. In a world,
each of those is a **stand-in**: a local server that _is_ the provider as far as the product can tell. It serves the
same paths and shapes, keeps state, returns the same errors, and sends webhooks signed the way the provider signs
them. So the product's own client code and webhook handlers run unchanged, and a world tests the real thing.

This document is the contract between Swarmbox, a stand-in, and a product. The words in it are the words Swarmbox's
tools and docs use.

## Words

| Word          | Means                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stand-in**  | A local server playing one provider (`twilio`, `email`, `s3`, `helcim`, `expo-push`, `stripe`…), one process per world.                                                |
| **Account**   | A provider account inside a stand-in: its fake credentials, e.g. a Twilio AccountSid and auth token, one per tenant if the product keeps one per tenant.               |
| **Outbound**  | What the product sent the provider: a text, a charge, an upload. The stand-in logs every one.                                                                          |
| **Inbound**   | Something that comes from outside: a customer's reply, a call, a tap at the card terminal, a dispute. The stand-in sends it to the product the way the provider would. |
| **Behaviour** | A named way the outside world goes wrong (below). Applied to the next N matching calls, or until cleared.                                                              |
| **Device**    | What the person's hardware does: camera, files, location, notifications, the phone, plus network, clock and shape (already in Swarmbox).                               |
| **Prop**      | A thing a person makes or carries: a photo, a document, a signature, a voice note. It's generated and tagged, so a check can tell which one arrived.                   |
| **Condition** | A scenario's plain words ("the card is declined"). The driving agent turns each into behaviours and device states.                                                     |

## Behaviours

There's one vocabulary for every stand-in. A stand-in's manifest lists the behaviours it supports, and the
`standin_behave` tool refuses any it doesn't.

| Behaviour   | Where            | What happens                                                                                      |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `fail`      | before accepting | The provider is down: a 5xx (or the provider's own outage answer).                                |
| `hang`      | before accepting | No answer at all, until the client gives up.                                                      |
| `slow`      | before accepting | It answers after `delayMs`.                                                                       |
| `limit`     | before accepting | Rate-limited: a 429 with the provider's retry header.                                             |
| `reject`    | before accepting | Refused as the provider refuses: an opted-out number, a bad address, an invalid card.             |
| `decline`   | payments         | The issuer declines.                                                                              |
| `timeout`   | payments         | Charged, but the answer is lost. The charge is real in the stand-in's state.                      |
| `late`      | after accepting  | It succeeds, but its confirmation (a receipt, a terminal's answer) comes after `delayMs`.         |
| `undeliver` | after accepting  | A text's receipt says undelivered.                                                                |
| `bounce`    | after accepting  | An email bounces, or is complained about (`param.as: "complaint"`).                               |
| `manual`    | after accepting  | No receipt at all. The agent sends receipts itself as inbound, in any order, any number of times. |
| `duplicate` | webhooks         | The next webhook is delivered twice.                                                              |
| `reorder`   | webhooks         | The next webhooks are delivered in reverse order.                                                 |
| `gone`      | after accepting  | The target no longer reaches anyone, e.g. a push token for a wiped iPad.                          |

A behaviour can match on `tenant`, `target` (a number, address or card) and `operation`, and it has a `count`, which
is unlimited when left out.

How Flowology's sandbox fakes map onto these:

- `fail_next` → `fail`, `hang_next` → `hang` and `rate_limit` → `limit`, each with count 1.
- `reject`, `bounce`, `undeliver`, `decline` and `timeout` keep their names.
- `receipts_manual` → `manual`, `approve_late` → `late`, and `gone_later` → `gone`.
- `no_answer` → `hang` on the terminal.
- `cancel_confirms` is a terminal inbound, not a behaviour.

## The manifest

Every stand-in ships a typed manifest. Swarmbox reads only the manifest and the stand-in's answers on its control
paths. **Swarmbox writes every word the agent sees about a stand-in, from this manifest. A stand-in supplies no free
text that the agent reads as guidance.**

```ts
interface StandInManifest {
  name: string; // "twilio": a slug, unique in the registry
  provider: string; // "Twilio": as people write it
  apiVersion: string; // the provider API it copies: "2010-04-01"
  surfaces: Surface[]; // what it plays: "sms", "voice", "recordings"
  connect: {
    // How a product reaches it. Every stand-in has a base address; the others are optional.
    baseUrls: Record<string, string>; // {"api": "/", "intelligence": "/intelligence"}: names a product maps to its own settings
    hosts?: string[]; // hosts it answers for through the proxy, for SDKs with fixed hosts (step 3)
    browser?: {
      // pages the world's browsers get from the stand-in instead of the provider
      origins: string[]; // exact https origins, e.g. ["https://secure.helcim.app"]: routed whole, so origin checks pass
    };
  };
  accounts: { fields: Record<string, 'id' | 'secret' | 'phone' | 'email' | 'text'> };
  behaviours: Behaviour[]; // which of the vocabulary it supports
  webhooks?: { headers: string[]; platform?: boolean }; // what its webhooks may carry besides content-type,
  // user-agent and accept; platform: they may also go to the product's own host
  answers?: {
    // how its provider says "down" and "slow down", for the behaviours Swarmbox applies itself
    fail?: { status: number; headers?: Record<string, string>; body?: unknown };
    limit?: { status: number; headers?: Record<string, string>; body?: unknown };
  };
  inbound: InboundKind[]; // what it can make arrive, each with a typed body
  clock: 'world' | 'real'; // which time it signs with (see Time)
  parity?: string; // its parity suite (step 3)
}
```

## A stand-in's process

A stand-in has **no network at all**. Swarmbox starts it as its own sandboxed process (see Security) before the
world's product starts. The two talk over the stand-in's stdin and stdout, one JSON message per line, as an MCP
server does. Swarmbox does everything that touches the network, for every stand-in:

- **It serves the stand-in's port.** Swarmbox listens on `127.0.0.1:<port>` and hands each request to the stand-in
  as `{type: "request", id, method, path, query, headers, body}`. Bodies go as base64. The stand-in answers
  `{type: "response", id, status, headers, body}`.
- **It applies the general behaviours**, `fail`, `hang`, `slow` and `limit`, before a request reaches the stand-in,
  using the provider's own status codes and headers from the manifest. So a stand-in implements only what's
  particular to its provider: `reject`, `decline`, `undeliver`, `bounce`, `timeout`, `late`, `manual` and `gone`.
- **It delivers webhooks, and hands back the product's answer.** The stand-in sends
  `{type: "deliver", id, url, method, headers, body}` and gets `{type: "delivered", id, status, contentType, body}`
  (at most 1 MB): Twilio, for one, reads the product's answer to a call as the TwiML to run. For a URL on a
  tenant's host, Swarmbox posts it to the world's product over loopback with that URL's `Host` header, so a product
  behind one port serves every tenant's host. The stand-in signs the URL as written. `duplicate` and `reorder` are
  applied here.
- **It keeps the log.** Every request, answer and delivery, in order. So `standin_log` works the same for every
  stand-in, and a stand-in can't hide or invent traffic.

The stand-in's own messages are for what only it knows:

| Message from Swarmbox                     | Does                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start {config}`                          | First, once: the world's base domain, the clock it signs with, and its temporary folder.                                                                                        |
| `account {tenant, settings}`              | Make an account, with what the product set for it as a person would in the provider's console (a number's webhook addresses). It answers with the credentials, all marked fake. |
| `behave {behaviour, match, count, param}` | One of its own behaviours, applied, listed or cleared.                                                                                                                          |
| `inbound {kind, ...typed body}`           | Make something arrive. It answers with what it delivered.                                                                                                                       |
| `clock {at, paused}`                      | The world's time, sent whenever the clock moves.                                                                                                                                |
| `reset`                                   | Forget everything except its accounts.                                                                                                                                          |

Swarmbox ships a small SDK, `defineStandIn({manifest, routes, inbound, behaviours})`, so an author writes handlers,
not a server or a message loop.

## Time

A world's clock can move. A stand-in signs with the clock its provider's checks use:

- **`world`:** the product checks the signature's time against its own clock, which follows the world. Resend
  (Svix) webhooks are like this: they're allowed 5 minutes of drift. The stand-in signs with the time Swarmbox last
  pushed.
- **`real`:** the check happens outside the product's clock. S3 is like this: the store refuses a request more than
  15 minutes from real time, so a product signs with real time (Flowology's QA-679), and the S3 stand-in checks
  against real time too.

## The product's side

A product declares the stand-ins it needs, and takes their addresses when a world starts:

```ts
interface Product {
  standins?: string[]; // ["twilio", "email", "s3", "helcim", "expo-push"]
  startWorld(spec: WorldSpec & { standins: StandInEndpoints }, port: number): Promise<W>;
}
interface StandInEndpoints {
  [name: string]: {
    baseUrls: Record<string, string>;
    account(tenant: string): Promise<Record<string, string>>;
  };
}
```

In its sandbox mode, the product builds its **real** provider clients, pointed at those base addresses. It provisions
each tenant's provider account with the credentials `account()` returns. Nothing else about its provider code
changes.

## The device and props

These are Swarmbox's own, with no stand-in involved:

| Tool                                | Does                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prop_make {kind, about}`           | Makes a photo (`about: "a water heater, rusted at the base"`, a JPEG), a document (a PDF) or a signature (a PNG), drawn by Swarmbox. Each is tagged with its id inside the file (a JPEG comment, a PNG text chunk, a line of the PDF's text) and visibly in a corner.    |
| `prop_list`                         | The props made so far.                                                                                                                                                                                                                                                   |
| `file_pick {screen, prop}`          | Queues a prop for the screen's next file chooser. On a phone or tablet the camera button usually opens one: Expo's image picker does on the web, for example. A chooser that opens with nothing queued is noted on the screen, and stays open, as it would for a person. |
| `camera_show {screen, prop}`        | For an app that opens a live camera (`getUserMedia`): the camera shows the prop, held still, or a grey frame when there's none. Every screen's camera is allowed, so no prompt can hang the page.                                                                        |
| `location_set {screen, lat, lng}`   | Where the device is, with the location allowed.                                                                                                                                                                                                                          |
| `notifications_set {screen, allow}` | Whether the device shows notifications.                                                                                                                                                                                                                                  |

A phone call ending (`call_hangup`) belongs to the voice stand-in, as an inbound.

## The agent's tools

| Tool                                                              | Does                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `standin_catalog`                                                 | What's available: each stand-in's provider, API version, surfaces, behaviours and inbound kinds, from the manifests. |
| `standin_add {world, name}`                                       | Adds a stand-in to a world that's starting; `world.standins` in a scenario does the same.                            |
| `standin_behave {world, name, behaviour, match?, count?, param?}` | Applies a behaviour.                                                                                                 |
| `standin_inbound {world, name, kind, ...}`                        | Makes something arrive.                                                                                              |
| `standin_log {world, name, after?}`                               | What the product sent and what the stand-in did.                                                                     |
| `inbox {world, tenant, to}`                                       | One person's texts, calls, email and push, across stand-ins (it replaces `phone_inbox`).                             |

## Security

A stand-in is untrusted code, and nothing it does may stop Swarmbox, reach past its world or steer the agent.

- **Each stand-in runs in an operating-system sandbox, with no network at all.** On macOS that's Seatbelt, as
  Anthropic's open-source sandbox runtime does it; on Linux, bubblewrap. Containers are the fallback.
  - **Reads are denied by default.** It can read its own package, Node, the kit and its own temporary folder, plus
    on macOS the OpenSSL settings Node reads as it starts. Nothing else on the disk is there for it: not the user's
    files, other temp folders (where worlds keep their database sockets), local databases' data or mounted
    volumes. Paths are compared as real paths, so symlinks don't open a way round.
  - It can write only its own temporary folder.
  - It gets no sockets of any kind and none of the developer's environment. Its only channel is stdin and stdout,
    to Swarmbox.
  - It can't start processes: on macOS the sandbox's profile denies fork. Wherever a process does start, stopping
    the stand-in kills everything under it in the process table, then its process group.
  - Swarmbox's own stand-ins run this way too, so the path every community stand-in takes is always the one in use.
  - Why not let it listen on its own port: on macOS the sandbox's "local binding" setting also allows connecting to
    every local port, which would put a developer's local databases and dev servers in reach.
- **A stand-in ships as bundled JavaScript with no runtime dependencies.** The kit imports only Node's own modules,
  so nothing outside those folders has to be readable. Node won't run TypeScript from inside `node_modules`, and a
  package manager's dependency folders would otherwise need opening up.
- **Nothing it sends can break Swarmbox.**
  - Every message is checked before it's used, and anything else on its stdout is ignored.
  - A message over 32 MB stops the stand-in.
  - An answer with a bad status, or headers that are invalid or frame the connection, becomes a 502.
  - Every wait has a limit:
    - 10 s to be ready;
    - 10 s for any control answer;
    - `requestTimeoutMs` (60 s by default) for a request, after which the product gets a 504.
  - When it exits, everything waiting on it is answered.
- **It can deliver only to its world.**
  - A webhook goes over plain HTTP to a tenant's host (`<tenant>.<baseDomain>`), on the world's port, and nowhere
    else. A stand-in whose manifest sets `webhooks.platform` (one email account for the whole platform) may also
    deliver to the product's own host, `<baseDomain>`.
  - It can't reach `localhost`, an address, or the product's `/_sandbox` hooks. The path is decoded until it stops
    changing and read without case, so `/%5Fsandbox`, `//_sandbox` and `/_SANDBOX` are refused too, as is any path
    with `_sandbox` in it.
  - It can use only standard methods, and carry only `content-type`, `user-agent`, `accept` and the headers its
    manifest declares under `webhooks.headers` (its signature and timestamp). So no cookies and no forwarded
    addresses.
  - At most 64 deliveries can be in flight at once.
  - The product's answer comes back to the stand-in (Twilio runs it as TwiML). So a stand-in can read what a
    tenant's host serves without signing in, as anyone on the internet could. It's still sandboxed, and what it
    makes of it reaches the agent only framed as its own.
- **It plays a provider's pages in the browser only where it was let.**
  - A manifest's `connect.browser.origins` are exact https origins (no `*`, braces, `?`, brackets, path or
    uppercase), matched as origins, never as patterns.
  - Each needs approving for that stand-in in `Product.standins[].browserOrigins` by whoever runs the product.
    Built-in stand-ins come with theirs approved. Never approve an origin the product loads its own code from: the
    stand-in's script would run in its signed-in pages. A world asking for an unapproved one is refused.
  - Never the product's own hosts, this machine, or an origin in `Product.browserAllow`.
  - A world whose browsers play a provider's pages is contained: they reach only the world's hosts, the routed
    origins, the world's stand-ins and `Product.browserAllow` (what the product loads from outside: fonts, maps).
    Every other request and WebSocket is blocked.
  - The routed pages carry a CSP of their own origin only, replacing any the stand-in sends.
  - A stand-in's redirects are Swarmbox's to follow, never the browser's, since a browser's next hop skips the
    routes: out of the world is refused (502); to a routed origin or a stand-in's own address, a page is sent on
    afresh and anything else is followed by Swarmbox, each hop checked. The stand-ins' own addresses on this
    machine (a presigned upload's) are reached through the same proxy.
  - The product is trusted. An open redirect of its own is a way out a stand-in could bounce the browser through,
    so a product run with stand-ins in the browser shouldn't have one.
- **A fake key can never work in production.**
  - Every credential a stand-in issues carries a mark, and Swarmbox checks each account before using it:
    - ids, secrets and text carry the word `swarmbox`, or the hex mark `c0ffee5b` where only hex will do (a
      Twilio AccountSid is `ACc0ffee5b…`);
    - phones are 555-0100 to 555-0199, the numbers kept for fiction;
    - emails are on `swarmbox.invalid`.
    - An unmarked account is refused.
  - A request carrying a real-looking live key (`sk_live_…`, `rk_live_…`, `AKIA…`, `ASIA…`) is refused before the
    stand-in sees it, and the key is never logged.
  - The package exports `assertNoStandins(env)`, for a product to call at start-up in production. It refuses
    marked credentials, fictional numbers, provider addresses on this machine however they're written (`127.1`,
    `0.0.0.0`, `[::1]`, `user@localhost`, `*.localhost`), and Swarmbox's local certificate authority. It names the
    variable and never the value.
- **The agent never reads a stand-in's own words as instructions.**
  - Tool descriptions come only from the checked manifest: labels are plain words, versions and hosts have fixed
    shapes, and unknown fields are refused.
  - What it returns from an inbound is reduced to plain JSON: short strings of plain characters, at most four levels
    deep.
  - Its refusals are cut to one plain line.
  - Its stderr goes to the operator's console, never to the agent.
  - Everything is shown to the agent marked as data. Free text from outside the scenario's own words (a message
    body, an email) can be screened by Jev before the agent reads it; Jev is an optional plugin.

## The stand-ins that come with Swarmbox

| Name        | Plays                             | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `twilio`    | Twilio, API 2010-04-01            | Texts with signed status callbacks (sent, then delivered or undelivered), refusals (21610), receipts by hand; a customer's text to the number's `smsUrl`; a call to its `voiceUrl` run through the product's TwiML (Dial, Say, Record, Reject, Hangup, each verb's `action` followed, and the next verb after a dial with none), answered at once and followed with the `call-status` inbound, answered, unanswered or busy, recorded, or held ringing until the caller hangs up, with its end posted to `voiceStatusUrl`; and the reads of calls, recordings (as MP3, at the stand-in's own address) and transcriptions. Voice Intelligence answers as not enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `email`     | Resend                            | `POST /emails` with its validation errors and Idempotency-Key, the `email.sent` then `email.delivered`, `email.bounced` or `email.complained` events to the account's `webhookUrl`, signed with Svix on the world's time; refusals and events by hand; and a mailbox read (inbound `mailbox`) of what one address was sent, so a sign-in code can be read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `s3`        | S3-compatible storage, path style | Every request checked with Signature Version 4 on the real clock, header-signed or presigned, as S3 holds it: the credential's date, region (the account's `region`, `auto` by default) and service, links of a week at most, `x-amz-content-sha256` required (`SignatureDoesNotMatch`, `RequestTimeTooSkewed`, `Request has expired`, `InvalidAccessKeyId`, `AuthorizationHeaderMalformed`). aws-chunked uploads, as the AWS SDK sends a stream, decoded: each chunk's signature checked in turn, and the trailer's. Content-MD5 and every `x-amz-checksum` (CRC32, CRC32C, CRC64NVME, SHA-1, SHA-256), in a header or the trailer, enforced (`BadDigest`); an object sent none gets S3's own CRC64NVME. Each account's buckets are its own. Heads and gets with ranges; deletes; uploads in parts with S3's rules (5 MB but the last, `EntityTooSmall`; ascending, `InvalidPartOrder`) and composite or full-object checksums; the list of unfinished uploads; and the browser's CORS preflight, open to the world's own hosts unless the bucket's account sets `corsOrigins`. Objects up to 15 MB (`EntityTooLarge`), since each body crosses to Swarmbox as one message. `limit` answers `503 SlowDown`. |
| `helcim`    | Helcim, API v2 and HelcimPay.js   | A checkout (`/helcim-pay/initialize`, an hour on the world's clock) and its card form in the browser at Helcim's own address (`https://secure.helcim.app`: `start.js`'s `appendHelcimPayIframe`, then the iframe's `postMessage` to the page, so the page's origin check passes), its result hashed as Helcim documents it, `sha256(json_encode(data) . secretToken)` with PHP's escaping (`\/`, `\uXXXX`); test cards (4111 1111 1111 1111 approves, 4000 0000 0000 0002 declines); a card saved for a customer by a `verify` checkout, then listed, charged by token and deleted; purchases and refunds with `idempotency-key` required, kept per account and operation for five minutes (another body under the same key is refused), refunds up to what remains; reads of transactions (by day and card) and customers, with dates in Mountain Time on the world's clock. `decline` declines the next charge, `timeout` keeps its answer (the product gets a 504, the charge stands), inbound `expire` expires a saved card. Not yet: the Smart Terminal and Helcim's webhooks.                                                                                                                          |
| `expo-push` | Expo's push service, v2           | `/--/api/v2/push/send`, a ticket per recipient, then `getReceipts` once a receipt is ready (kept a day on the world's clock). `DeviceNotRegistered` for a token it doesn't know and for a wiped or removed device (`gone`, at the receipt or with `param.at: "ticket"` at the ticket; inbound `unregister`); `MessageTooBig` past 4096 bytes; `reject` as `InvalidCredentials` or `param.as: "MessageRateExceeded"`; `late` keeps a receipt back `param.delayMs`; Expo's limits (100 per send, 1000 receipts per read, one project per send). Enhanced push security per account. The agent registers devices (inbound `register`, an `ExponentPushToken[…]` for a tenant's project) and reads what one got (`received`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A product lists them with `builtinStandIn('twilio')` in `Product.standins`, and gives each tenant's account its console
settings: `account(tenant, {smsUrl, voiceUrl, voiceStatusUrl})` for Twilio, `account(tenant, {webhookUrl})` for email,
`account(tenant, {region, corsOrigins})` for S3. A product with one email account for everyone uses one tenant for it.
Expo push takes `account(tenant, {enhancedSecurity: "on"})` to turn away requests without that account's
`accessToken`. Helcim needs none: its card form is routed in the world's browsers, so a product's pay page loads
`start.js` from Helcim's address as it would live.

## Order of work

1. This contract, the runner (with the sandbox checked on macOS), the control paths, the tools, the production guard,
   then the device and props.
2. Flowology's stand-ins: `twilio` (sms, voice, recordings), `email` (Resend), `s3`, `helcim` (checkout with its
   browser page, saved cards, refunds, the terminal) and `expo-push`. Flowology then switches to them.
3. The intercepting proxy for fixed-host SDKs, parity suites in weekly CI, books connectors as Flowology needs them,
   and `stripe`.
4. The registry for community stand-ins: submission checks, Jev's screens and revocation.
