// Secrets out of what Swarmbox keeps and shows: a screen's requests (requests.ts) and a stand-in's log
// (standins/runner.ts). Both reach the agent, and from the agent a finding, run.json and the report, so a value
// is replaced before it is stored, never after.
//
// A value is a secret's when its name says so, or when it is shaped like a token. Names are read in JSON, in a
// form (urlencoded or multipart), in a query string, in XML elements and attributes, and in name/value pairs (a
// report server's <Name>Password</Name><Value>…</Value>, {"name": "password", "value": "…"}, or a validation
// error's {"loc": ["body", "password"], "input": "…"}).
//
// Bodies run to a megabyte and are read on the server's own thread, so every pattern is bounded: none may
// backtrack its way through a body built to make it.

/** A name is a secret's when its last word is one of these, or its last two are one of the pairs. */
const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'passcode',
  'passphrase',
  'secret',
  'token',
  'auth',
  'authorization',
  'cookie',
  'session',
  'signature',
  'credential',
  'credentials',
  'otp',
  'apikey',
]);
const SECRET_PAIRS = new Set(['apikey', 'sessionid', 'accesskey', 'privatekey', 'secretkey']);
/** A last word run together from others ("dbpassword", "csrftoken") still ends in its secret. */
const SECRET_ENDINGS = ['password', 'passwd', 'passphrase', 'secret', 'token'];
/** A JWT or JWE (base64url segments, the first a JSON header), or an opaque string long enough to be a key. */
const TOKEN_SHAPED = /^(eyJ[\w-]*\.[\w.-]+|(Bearer|Basic)\s+\S+|[A-Za-z0-9_+/=-]{40,})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REDACTED = '[redacted]';

/** By its words, so that "two_signature_threshold" is not a secret and "x-api-key" or "AuthToken" is. */
export function secretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? '';
  return (
    SECRET_WORDS.has(last) ||
    SECRET_PAIRS.has(words.slice(-2).join('')) ||
    SECRET_ENDINGS.some((w) => last.endsWith(w))
  );
}

function secretValue(name: string, value: string): boolean {
  return secretName(name) || (TOKEN_SHAPED.test(value) && !UUID.test(value));
}

/** An address with its secret query values replaced; on `origin`, only its path and query. */
export function redactUrl(url: string, origin?: string): string {
  // A blob: address is a page's own object, named by the origin that made it: redacted as that address.
  if (/^blob:/i.test(url)) return `blob:${redactUrl(url.slice(5))}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const [k, v] of [...u.searchParams]) if (secretValue(k, v)) u.searchParams.set(k, REDACTED);
  // A token in the path, as a customer's link carries one.
  u.pathname = u.pathname
    .split('/')
    .map((seg) => (TOKEN_SHAPED.test(seg) && !UUID.test(seg) ? REDACTED : seg))
    .join('/');
  const shown = u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  return origin && u.origin === origin ? shown.slice(origin.length) || '/' : shown;
}

/** A path and query (as a server sees a request) with its secrets replaced. */
export function redactTarget(target: string): string {
  const here = 'http://redact.invalid';
  if (/^https?:\/\//i.test(target)) return redactUrl(target);
  return target.startsWith('/') ? redactUrl(`${here}${target}`, here) : target;
}

/** The keys that name a name/value pair's secret, in any case: {"Name": "Password", "Value": "…"}. */
const PAIR_NAME = new Set(['name', 'key', 'field', 'parameter']);
/** The keys that hold its value: a validation error echoes what it refused as "input". */
const PAIR_VALUE = new Set(['value', 'input']);

/** What a pair is named: by one of its name keys, or by the last word of a validation error's loc. */
function pairName(o: Record<string, unknown>): string | undefined {
  for (const [k, x] of Object.entries(o)) {
    const key = k.toLowerCase();
    if (PAIR_NAME.has(key) && typeof x === 'string') return x;
    if (key === 'loc' && Array.isArray(x)) {
      const last = x.at(-1);
      if (typeof last === 'string') return last;
    }
  }
  return undefined;
}

function redactJson(v: unknown, name = ''): unknown {
  if (typeof v === 'string') return secretValue(name, v) ? REDACTED : v;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, name));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const named = pairName(o);
    const pair = named !== undefined && secretName(named);
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) =>
        (secretName(k) || (pair && PAIR_VALUE.has(k.toLowerCase()))) && x !== null && typeof x !== 'object'
          ? [k, REDACTED]
          : [k, redactJson(x, k)],
      ),
    );
  }
  return v;
}

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/** A form with its secret fields' values replaced and every other byte as it was. */
function redactForm(t: string): string {
  return t
    .split('&')
    .map((field) => {
      const at = field.indexOf('=');
      if (at < 0) return field;
      const name = field.slice(0, at);
      return secretValue(decoded(name), decoded(field.slice(at + 1))) ? `${name}=${REDACTED}` : field;
    })
    .join('&');
}

/** A multipart form's parts, each a secret's when its name is. */
function redactMultipart(body: string, boundary: string): string {
  const sep = `--${boundary}`;
  return body
    .split(sep)
    .map((part) => {
      const gap = /\r?\n\r?\n/.exec(part);
      if (!gap) return part;
      const headers = part.slice(0, gap.index);
      const content = part.slice(gap.index + gap[0].length);
      // The part ends at the line break before the next boundary.
      const end = /\r?\n$/.exec(content)?.[0] ?? '';
      const value = content.slice(0, content.length - end.length);
      const name = /\bname="([^"]*)"/i.exec(headers)?.[1];
      const type = /^content-type:[ \t]*([^\r\n]*)/im.exec(headers)?.[1] ?? '';
      const kept = name !== undefined && secretName(name) ? REDACTED : redactBody(value, type);
      return `${headers}${gap[0]}${kept}${end}`;
    })
    .join(sep);
}

const FORM_SHAPED = /^[^\s=&<>{}]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/;
/** <ns:Password attr="…">value</ns:Password>: the value. */
const XML_ELEMENT = /<((?:[\w.-]{1,64}:)?([\w.-]{1,128}))(\s[^<>]{0,2048})?>([^<]*)<\/\1\s{0,16}>/g;
/** <Name xsi:type="…">Password</Name> <Value>value</Value>: the value. */
const XML_PAIR = new RegExp(
  '(<((?:[\\w.-]{1,64}:)?Name)(?:\\s[^<>]{0,2048})?>([^<]{0,256})<\\/\\2\\s{0,16}>\\s{0,256}' +
    '<((?:[\\w.-]{1,64}:)?Value)(?:\\s[^<>]{0,2048})?>)([^<]*)(<\\/\\4\\s{0,16}>)',
  'gi',
);
/** Where a CDATA section was set aside: its number between two private-use characters. */
const SET_ASIDE = /\uE000(\d+)\uE001/g;

/**
 * The text with each CDATA section set aside (its value may hold "<"), so an element whose value is one reads
 * as an element with text. Found by indexOf, so a section never closed is never rescanned.
 */
function setAsideCdata(t: string): { text: string; sections: string[] } {
  const sections: string[] = [];
  if (t.includes('\uE000')) return { text: t, sections };
  let text = '';
  let at = 0;
  for (let open = t.indexOf('<![CDATA['); open >= 0; open = t.indexOf('<![CDATA[', at)) {
    const close = t.indexOf(']]>', open + 9);
    if (close < 0) break;
    text += `${t.slice(at, open)}\uE000${sections.length}\uE001`;
    sections.push(t.slice(open, close + 3));
    at = close + 3;
  }
  return { text: text + t.slice(at), sections };
}
/** A tag, up to the next angle bracket, so a run of "<" never rescans the rest of the body. */
const XML_TAG = /<[^<>]*>/g;
/** password="value" inside a tag. */
const XML_ATTRIBUTE = /(\s([\w.:-]{1,128})\s{0,16}=\s{0,16})("[^"]*"|'[^']*')/g;
/** "password": "value" in JSON that could not be read whole (cut short), the value perhaps unfinished. */
const JSON_PAIR = /("([^"\\]{1,100})"\s*:\s*)"((?:[^"\\]|\\.)*)("?)/g;
/** "otp": 441723 in JSON: a secret kept as a number. */
const JSON_NUMBER = /("([^"\\]{1,100})"\s*:\s*)(-?\d[\d.eE+-]*)/g;

/**
 * Text with its secrets replaced in place, never reshaped: name/value pairs in JSON (cut short or whole) and in
 * XML and SOAP, or the whole of it when it is one token. A download's text is redacted this way.
 */
export function redactText(t: string): string {
  let out = t;
  if (out.includes('<')) {
    const { text, sections } = setAsideCdata(out);
    out = text
      .replace(XML_PAIR, (m, open: string, _n, name: string, _v, _value, close: string) =>
        secretName(name.trim()) ? `${open}${REDACTED}${close}` : m,
      )
      .replace(XML_ELEMENT, (m, tag: string, local: string, attrs: string | undefined, value: string) =>
        secretName(local) && value.trim() ? `<${tag}${attrs ?? ''}>${REDACTED}</${tag}>` : m,
      )
      .replace(XML_TAG, (tag) =>
        tag.replace(XML_ATTRIBUTE, (m, lead: string, name: string, q: string) =>
          secretName(name) ? `${lead}${q[0]}${REDACTED}${q[0]}` : m,
        ),
      )
      .replace(SET_ASIDE, (m, i: string) => sections[Number(i)] ?? m);
  }
  out = out.replace(JSON_PAIR, (m, lead: string, name: string, value: string, end: string) =>
    secretValue(name, value) ? `${lead}"${REDACTED}${end}` : m,
  );
  out = out.replace(JSON_NUMBER, (m, lead: string, name: string) =>
    secretName(name) ? `${lead}"${REDACTED}"` : m,
  );
  return TOKEN_SHAPED.test(out.trim()) && !UUID.test(out.trim()) ? REDACTED : out;
}

/**
 * A body with its secrets replaced: JSON by key (and name/value pairs), a form by field (a multipart one by
 * part), XML by element, attribute and name/value pair, anything else only if it is one token.
 */
export function redactBody(body: string, contentType = ''): string {
  const multipart = /multipart\/form-data/i.test(contentType)
    ? /boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType)
    : null;
  if (multipart) return redactMultipart(body, multipart[1] ?? multipart[2]!);
  const t = body.trim();
  if (/json/.test(contentType) || /^[[{]/.test(t)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(t)));
    } catch {
      // Not JSON after all, or cut short: treated as text below.
    }
  }
  if (/x-www-form-urlencoded/.test(contentType) || (!/xml|json/.test(contentType) && FORM_SHAPED.test(t)))
    return redactForm(t);
  return redactText(body);
}
