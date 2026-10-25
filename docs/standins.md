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
      origins: string[]; // e.g. ["https://secure.helcim.app"]: routed whole, so origin checks still pass
    };
  };
  accounts: { fields: Record<string, 'id' | 'secret' | 'phone' | 'email' | 'text'> };
  behaviours: Behaviour[]; // which of the vocabulary it supports
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
- **It delivers webhooks.** The stand-in sends `{type: "deliver", id, url, method, headers, body}`. For a URL on a
  tenant's host, Swarmbox posts it to the world's product over loopback with that URL's `Host` header, so a product
  behind one port serves every tenant's host. The stand-in signs the URL as written. `duplicate` and `reorder` are
  applied here.
- **It keeps the log.** Every request, answer and delivery, in order. So `standin_log` works the same for every
  stand-in, and a stand-in can't hide or invent traffic.

The stand-in's own messages are for what only it knows:

| Message from Swarmbox                     | Does                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `start {config}`                          | First, once: the world's base domain, the clock it signs with, and its temporary folder. |
| `account {tenant}`                        | Make an account; it answers with the credentials, all marked fake.                       |
| `behave {behaviour, match, count, param}` | One of its own behaviours, applied, listed or cleared.                                   |
| `inbound {kind, ...typed body}`           | Make something arrive. It answers with what it delivered.                                |
| `clock {at, paused}`                      | The world's time, sent whenever the clock moves.                                         |
| `reset`                                   | Forget everything except its accounts.                                                   |

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

| Tool                              | Does                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `prop_make {kind, about}`         | Makes a photo (`about: "a water heater, rusted at the base"`), a PDF document, a signature or a voice clip. It's tagged invisibly with its id. |
| `camera_show {screen, prop}`      | The screen's camera shows the prop, as a still or a video. Chromium plays a file as its camera.                                                |
| `file_pick {screen, prop}`        | The next file chooser on the screen picks the prop.                                                                                            |
| `location_set {screen, lat, lng}` | Where the device is.                                                                                                                           |
| `notifications {screen, allow}`   | Whether the device allows notifications.                                                                                                       |
| `call_hangup {world, call}`       | Ends a call that a stand-in started.                                                                                                           |

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

- **Each stand-in runs in an operating-system sandbox, with no network at all.** On macOS that's Seatbelt, as
  Anthropic's open-source sandbox runtime does it; on Linux, bubblewrap; containers are the fallback.
  - It can read its own package and write its own temporary folder, and nothing else.
  - It gets no sockets of any kind and none of the developer's environment. Its only channel is stdin and stdout,
    to Swarmbox.
  - Swarmbox's own stand-ins run this way too, so the path every community stand-in takes is always the one in use.
  - Why not let it listen on its own port: on macOS the sandbox's "local binding" setting also allows connecting to
    every local port, which would put a developer's local databases and dev servers in reach.
- **The agent never reads a stand-in's own words as instructions.** Tool descriptions come from the manifest.
  Control-path answers are checked against their schemas, and are shown to the agent marked as data. Free text from
  outside the scenario's own words (a message body, an email) can be screened by Jev before the agent reads it; Jev
  is an optional plugin.
- **A fake key can never work in production.**
  - Every credential a stand-in issues carries `swarmbox` in it, e.g. `sk_test_swarmbox_…` or `ACswarmbox…`.
  - Stand-ins refuse real-looking keys (`sk_live_…`, `AKIA…`).
  - The package exports `assertNoStandins(env)`, for a product to call at start-up in production. It refuses
    Swarmbox credentials, loopback provider addresses, and Swarmbox's local certificate authority.

## Order of work

1. This contract, the runner (with the sandbox checked on macOS), the control paths, the tools, the production guard,
   then the device and props.
2. Flowology's stand-ins: `twilio` (sms, voice, recordings), `email` (Resend), `s3`, `helcim` (checkout with its
   browser page, saved cards, refunds, the terminal) and `expo-push`. Flowology then switches to them.
3. The intercepting proxy for fixed-host SDKs, parity suites in weekly CI, books connectors as Flowology needs them,
   and `stripe`.
4. The registry for community stand-ins: submission checks, Jev's screens and revocation.
