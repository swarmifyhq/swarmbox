# Changelog

What each release changes for a product that uses Swarmbox. Newest first. A change lands under
Unreleased; the release names the version.

## Unreleased

- A tool that fails gives the agent up to 40 lines (4000 characters) of the error, not just its first line, and
  writes the whole of it to serve's output. A world whose seed script failed answered `run_start` with only
  "world_seed.py failed (1):", and the traceback below it, which held the cause, reached neither.
- The README lists what the stand-in sandbox needs on Linux: bubblewrap, socat and ripgrep.
- A screen's downloads are kept: `screen_downloads` lists the files a screen saved (an export, a report, a
  statement) and reads a text file's contents a page at a time, and an action that saved one says
  "downloaded: #1 jobs.csv (2.0 KB, text)". A browser draws nothing for a download, so a tester could press
  Export and never know what came out, or whether anything did. Each file is read through its stream (a remote
  browser has no path), fingerprinted, and kept as text up to 500,000 characters. Its secrets are redacted:
  token-shaped words anywhere in it, and in a CSV or TSV every cell under a secret-named header.
  A download's text is the file as it is: redacted in place, never reparsed, so a JSON export's `424.10` and
  its 20-digit ids read as written. A UTF-16 export (a spreadsheet's "Unicode text") is read by its byte-order
  mark. A long run of key characters is redacted only when it mixes letters and digits and isn't a path. A page's
  own blob: file shows its address whole; a data: one shows only its type and length; any address is cut at 300
  characters. The browser's copy is deleted once read: it sat in the temp folder, which is memory on some
  machines, until the screen closed.
- A blob: address in `screen_requests` shows whole, not cut to `:3110/<id>`.

## 0.18.0 (2026-11-11)

- `serve` takes `standinSandbox`, and reads `SWARMBOX_NO_SANDBOX=1` as "off" when it isn't given. Before, only a
  product that built its own harness could run stand-ins on a machine without the operating-system sandbox; through
  `serve`, `run_start` refused with "stand-ins need the operating-system sandbox".
- A jump of the world's clock waits for the product's background work first, and says what was still
  outstanding if it didn't catch up. A retry set on the world's time came due only at the next jump, so a text
  whose first send failed went out at the jump, and read as the product being late. `moveClock` returns
  `settledBefore` (or `settleError`) for a jump; a read, a pause and a play wait for nothing.
- `screen_act` can `reload` a page. A `goto` to the address it's already on fetches nothing when only a hash is
  the same, so it was never a reload, and a tester could read an unchanged page as stuck.
- A check can name the bugs it guards, in `guards` on its result. A bug that's fixed has no known red left, so
  until now no rule could speak for it. A passing guard that looked at something backs a tester's hold in the
  same run, as its own row, and is no hold by itself. A guard's red counts as came-back for a bug the run was
  asked about or a tester held.
- A phone or tablet screen says what it is: `phone` sends an iPhone's Safari user agent, `tablet` and
  `tablet-portrait` an iPad's, and a sign-in's own touch viewport the one its shorter side matches. A product that
  names the device someone signed in on no longer calls every phone a computer.

## 0.17.0 (2026-11-07)

- A run can say what became of the things it was asked to look at again. `run_start` takes `recheck`, the new
  `result_log` records held, came-back or not-reached with a picture, and `run_end` writes `results.json` beside
  the report. It needs no tracker. Anything on the list that nobody spoke to reads not-reached. A known red that
  now passes backs a tester's hold in the same run, as its own row, and is no hold by itself: the run may not have
  gone near it.
- `FindingSink.register` is given the results as `results`.

## 0.16.0 (2026-11-05)

- An action's readout no longer puts down to the action what the server did before it began. What happened
  between two actions (an iPad's queued work sending once it's back online, another screen's work) is listed
  under "before this:", and "server:" holds only what came during the action. It used to read as if opening a
  panel had recorded a part and an invoice line. (Seen in a Flowology crew run.)

## 0.15.0 (2026-11-04)

- `run_start` answers within 45 seconds, before an MCP client gives up on the call (60 s by default,
  `claude -p` included). A world still starting gets the run's id and "still starting"; `run_status` with
  that `run` waits for it and then gives the cast, what to try and what good looks like. Calling
  `run_start` again for a scenario whose start no client has taken gives back the same start, not a
  second world nobody ends. `SWARMBOX_START_WAIT_MS` changes the wait. (Reported by Certainty.)
- `world_create` answers within the same time, with the world's id; `world_list` shows worlds still
  starting, and ones that failed to start in the last 10 minutes with why.
- `run_end` closes a run whose world has already stopped: the report says no checks could run, and
  `run_status` marks such a run. It used to answer "there is no world" and stay in progress until the
  serve restarted. (Reported by Certainty.)
- `Harness.createWorld` returns the world's id with its promise, and `Harness.startingWorlds()` lists the
  ones starting.
- This changelog, in the package.
- `screen_act` click takes `button` (`right` for a menu that opens only on a right click, or `middle`)
  and `clickCount` (2 for a double click). (Reported by Certainty.)
- Role `"text"` finds an element with no role by its visible text, wherever a role and name are taken:
  click, drag and its `to`, and scroll. (Reported by Certainty.)
- `drag` takes `grabOffset {x, y}`, CSS pixels added to where it is held, for a move handle beside the
  element (an icon with no name next to a row's text). (Reported by Certainty.)
- An overlay a dialog opened (a dropdown's panel, which PrimeNG, Radix and others put at the end of the
  page, outside the dialog) counts as in front when it is drawn over the dialog: its options can be
  clicked, not refused as "behind the open dialog". (Reported by Certainty.)
- A dropdown with no accessible name is found by its label, its placeholder, or the text it shows
  ("Choose groups"). (Reported by Certainty.)
- Of several matches alike, each is described by the row it's in or the heading above it, so one can be
  picked by index. (Reported by Certainty.)
- An action's readout says more of what changed: a menu, listbox or tooltip that opened or closed, new
  text and text gone (an inline form, a total, a validation message in no live region), and the same text
  in a new order (a drag that reorders). "Nothing a person would notice" now means it. (Reported by
  Certainty and Quarry View.)
- The S3 stand-in lists a bucket's keys: ListObjects V1 and V2, with prefix, delimiter and common
  prefixes, max-keys and paging. It used to answer 400 to a bucket list. An account's `buckets` setting
  makes buckets that are there before the product starts. (Reported by Certainty.)
- Devices `desktop-hd` (1920×1080) and `desktop-qhd` (2560×1440), for layouts that go wrong only on a big
  monitor. (Reported by Certainty.)

## 0.14.0 (2026-11-04)

- `phone_inbox` also shows what a product sends as itself rather than as a tenant (sign-in codes,
  invites, sign-up confirmations), marked sentAs "the platform", when the product names its
  `platformMailbox`.
- A tenant made during a run (the product's own sign-up) is reachable by its links and its people, when
  the product gives `currentTenants()`.
- `world_clock` gives the wall clock and UTC offset in each zone the world's people are in, and says
  that moving the clock doesn't make the product's own background work finish sooner.
- `phone_authenticator`: the code an authenticator app shows for a two-step setup key or otpauth link
  (RFC 6238; SHA1, SHA256, SHA512; 6–8 digits), at the world's time.

## 0.13.0 (2026-11-02)

- A world's browsers are contained whenever the product names what its pages load from outside;
  `world_list` says whether they are.
- `screen_requests`: a screen's own requests (method, path, query, status, a bounded body), with secrets
  redacted, and refusals that say why.
- `screen_act` scroll, and drags onto a point below the fold or by a distance that scrolls first.
- An action's readout waits for the requests it started, and names new headings.
- A path given to `screen_open` or `goto` must stay on the screen's own host: `//host` and `/\host` are
  refused.
- The stand-in log keeps no passwords, tokens or keys.
- The email stand-in keeps attachments whole, lists sent emails as Resend's `GET /emails` does, and
  downloads any filename; a refused email keeps no files.
- A stand-in account asked for again keeps its credentials and changes only its settings.
- A product's hooks can serve a clock and no feed.
- Ctrl-C stops every world before anything exits, with a screen open too.

Earlier releases have no notes here; their commits are in the repository's history.
