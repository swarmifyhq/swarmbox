// Secrets out of what Swarmbox keeps and shows: a screen's requests (requests.ts) and a stand-in's log
// (standins/runner.ts). Both reach the agent, and from the agent a finding, run.json and the report, so a value
// is replaced before it is stored, never after.
//
// A value is a secret's when its name says so, or when it is shaped like a token. Names are read in JSON, in a
// form, in a query string, in XML elements and attributes, and in name/value pairs (a report server's
// <Name>Password</Name><Value>…</Value>, or {"name": "password", "value": "…"}).

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

/** The key that names a name/value pair's secret: {"name": "password", "value": "…"}. */
const PAIR_NAME = ['name', 'key', 'field', 'parameter'];

function redactJson(v: unknown, name = ''): unknown {
  if (typeof v === 'string') return secretValue(name, v) ? REDACTED : v;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, name));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const named = PAIR_NAME.map((k) => o[k]).find((n): n is string => typeof n === 'string');
    const pair = named !== undefined && secretName(named) && 'value' in o;
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) =>
        (secretName(k) || (pair && k === 'value')) && x !== null && typeof x !== 'object'
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

const FORM_SHAPED = /^[^\s=&<>{}]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/;
/** <ns:Password attr="…">value</ns:Password>: the value. */
const XML_ELEMENT = /<((?:[\w.-]+:)?([\w.-]+))(\s[^>]*)?>([^<]*)<\/\1\s*>/g;
/** <Name>Password</Name> <Value>value</Value>: the value. */
const XML_PAIR =
  /(<((?:[\w.-]+:)?Name)\s*>\s*([^<]+?)\s*<\/\2\s*>\s*<((?:[\w.-]+:)?Value)\s*>)([^<]*)(<\/\4\s*>)/gi;
/** password="value" inside a tag. */
const XML_ATTRIBUTE = /(\s([\w.:-]+)\s*=\s*)("[^"]*"|'[^']*')/g;
/** "password": "value" in JSON that could not be read whole (cut short), the value perhaps unfinished. */
const JSON_PAIR = /("([^"\\]{1,100})"\s*:\s*)"((?:[^"\\]|\\.)*)("?)/g;

/** Text that is not whole JSON or a form: XML and SOAP, JSON cut short, or one token. */
function redactText(t: string): string {
  let out = t;
  if (out.includes('<')) {
    out = out
      .replace(XML_PAIR, (m, open: string, _n, name: string, _v, _value, close: string) =>
        secretName(name) ? `${open}${REDACTED}${close}` : m,
      )
      .replace(XML_ELEMENT, (m, tag: string, local: string, attrs: string | undefined, value: string) =>
        secretName(local) && value.trim() ? `<${tag}${attrs ?? ''}>${REDACTED}</${tag}>` : m,
      )
      .replace(/<[^>]*>/g, (tag) =>
        tag.replace(XML_ATTRIBUTE, (m, lead: string, name: string, q: string) =>
          secretName(name) ? `${lead}${q[0]}${REDACTED}${q[0]}` : m,
        ),
      );
  }
  out = out.replace(JSON_PAIR, (m, lead: string, name: string, value: string, end: string) =>
    secretValue(name, value) ? `${lead}"${REDACTED}${end}` : m,
  );
  return TOKEN_SHAPED.test(out.trim()) && !UUID.test(out.trim()) ? REDACTED : out;
}

/**
 * A body with its secrets replaced: JSON by key (and name/value pairs), a form by field, XML by element,
 * attribute and name/value pair, anything else only if it is one token.
 */
export function redactBody(body: string, contentType = ''): string {
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
