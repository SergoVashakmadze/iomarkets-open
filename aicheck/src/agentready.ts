// The agent-readiness check for financial APIs: is an OpenAPI description or an MCP server's tool list ready for AI
// agents that move money or read market data? Pure: it reads the JSON. Kept narrow to what finance needs (developer
// experience in general is iomarkets.dev's): every amount says its unit and currency and is not a float, every time
// says its time zone, identifiers name their standard (ISO 4217, ISO 3166, ISIN, LEI, BIC, IBAN), errors and rate
// limits are described so an agent can act on them, calls that move money take an idempotency key, and MCP tools that
// trade or pay are marked destructive. Field names with an ISO 20022 equivalent are suggested, not required.

export type Level = 'pass' | 'warn' | 'fail' | 'info';
export type Issue = { level: Exclude<Level, 'pass'>; code: string; where: string; message: string; fix: string };
export type Result = {
  kind: 'openapi' | 'mcp';
  title: string;
  counted: { operations: number; fields: number };
  checks: { code: string; title: string; level: Level; detail: string }[];
  issues: Issue[];
  score: number;
  iso20022: { field: string; where: string; iso: string }[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const MONEY = /^(amount|amt|price|px|cost|fee|fees|balance|bal|value|notional|total|subtotal|tax|commission|premium|payout|proceeds|pnl|equity|cash|limit_price|stop_price|strike|nav)$|(_amount|Amount|_price|Price|_fee|Fee|_balance|Balance|_value|Value|_cost|Cost|_cash|Cash|_notional|Notional)$/;
const QTY = /^(qty|quantity|size|shares|units|volume|filled_qty|filledQty)$|(_qty|Qty|_quantity|Quantity|_size|Size)$/;
const TIME = /(^|_)(time|timestamp|ts|date|datetime|at)$|(Time|Timestamp|Date|At)$|^(created|updated|expires|settled|executed|filled|submitted)(_at|At)?$/;
const UNIT_WORDS = /\b(usd|eur|gbp|jpy|currency|iso ?4217|minor units?|cents?|pence|basis points?|bps|percent|%|decimal|per (share|unit|contract)|in the (account|asset|quote|base) currency|denominated|units? of)\b/i;
const TZ_WORDS = /\b(utc|z\b|time ?zone|timezone|gmt|offset|iso ?8601|rfc ?3339|epoch|unix|seconds since|milliseconds|nanoseconds|exchange time|new york time|et\b)/i;
const MOVES_MONEY = /(order|orders|trade|trades|payment|payments|transfer|transfers|withdraw|withdrawal|payout|deposit|swap|send|buy|sell|charge|refund|redeem|subscribe)/i;

/** Field names with an ISO 20022 element that means the same, for teams that want to map onto it. */
export const ISO_NAMES: Record<string, string> = {
  amount: 'InstdAmt / Amt (with Ccy)',
  currency: 'Ccy (ISO 4217)',
  ccy: 'Ccy (ISO 4217)',
  reference: 'EndToEndId',
  end_to_end_id: 'EndToEndId',
  client_order_id: 'EndToEndId or InstrId',
  payer: 'Dbtr',
  payee: 'Cdtr',
  debtor: 'Dbtr',
  creditor: 'Cdtr',
  beneficiary: 'Cdtr',
  sender: 'Dbtr',
  recipient: 'Cdtr',
  iban: 'IBAN (CdtrAcct/DbtrAcct)',
  account_number: 'Acct/Id/Othr/Id',
  bic: 'BICFI',
  swift: 'BICFI',
  lei: 'LEI',
  isin: 'FinInstrmId/ISIN',
  value_date: 'IntrBkSttlmDt / ValDt',
  settlement_date: 'SttlmDt',
  trade_date: 'TradDt',
  remittance: 'RmtInf/Ustrd',
  memo: 'RmtInf/Ustrd',
  purpose: 'Purp/Cd',
  country: 'Ctry (ISO 3166)',
};
const STANDARD: [RegExp, RegExp, string][] = [
  [/^(currency|ccy|currency_code|currencyCode)$/, /iso ?4217|^[\^]?\[A-Z\]\{3\}/i, 'ISO 4217 currency code'],
  [/^(country|country_code|countryCode)$/, /iso ?3166/i, 'ISO 3166 country code'],
  [/^isin$/i, /isin|iso ?6166/i, 'ISIN (ISO 6166)'],
  [/^lei$/i, /lei|iso ?17442/i, 'LEI (ISO 17442)'],
  [/^(bic|swift|swift_code|bic_code)$/i, /bic|iso ?9362/i, 'BIC (ISO 9362)'],
  [/^iban$/i, /iban|iso ?13616/i, 'IBAN (ISO 13616)'],
];

type Field = { name: string; where: string; schema: Obj };

/** Every named property under a schema, following $ref into components and through arrays and allOf/oneOf/anyOf. */
function fieldsOf(schema: unknown, where: string, resolve: (ref: string) => Obj | null, out: Field[] = [], seen = new Set<string>()): Field[] {
  if (!isObj(schema)) return out;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return out;
    seen.add(schema.$ref);
    return fieldsOf(resolve(schema.$ref), where, resolve, out, seen);
  }
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) if (Array.isArray(schema[k])) (schema[k] as unknown[]).forEach((s) => fieldsOf(s, where, resolve, out, seen));
  if (isObj(schema.items)) fieldsOf(schema.items, `${where}[]`, resolve, out, seen);
  if (isObj(schema.properties)) {
    for (const [name, s] of Object.entries(schema.properties)) {
      const resolved = isObj(s) && typeof s.$ref === 'string' ? { ...(resolve(s.$ref) ?? {}), ...s } : (s as Obj);
      out.push({ name, where: `${where}.${name}`, schema: resolved });
      fieldsOf(s, `${where}.${name}`, resolve, out, seen);
    }
  }
  return out;
}

/** Checks on one field: unit and type for money, time zone for times, the standard for identifiers. */
function fieldIssues(f: Field, siblings: string[], issues: Issue[], iso: Result['iso20022']) {
  const d = `${str(f.schema.description)} ${str(f.schema.title)} ${str(f.schema.format)} ${str(f.schema.pattern)}`;
  const type = [f.schema.type].flat().map(String);
  // A name like proof_price can be a count ("Calls a month to /v1/proof/price"): a description that counts isn't money.
  const counts = /\b(calls?|count|number of|how many|times)\b/i.test(str(f.schema.description)) && !UNIT_WORDS.test(d);
  if (MONEY.test(f.name) && !counts && !/(_id|Id|count|Count|percent|Pct|_pct|rate|Rate)$/.test(f.name)) {
    const hasCcy = siblings.some((s) => /^(currency|ccy|currency_code|currencyCode)$/.test(s));
    if (!UNIT_WORDS.test(d) && !hasCcy) issues.push({ level: 'fail', code: 'AMOUNT_UNIT', where: f.where, message: `“${f.name}” is an amount with no currency or unit: an agent can’t tell dollars from cents, or which currency.`, fix: 'Say the currency (or that it is the account currency) and the unit in the description, or add a currency field beside it.' });
    if (type.includes('number') && !/decimal|string/i.test(d)) issues.push({ level: 'warn', code: 'AMOUNT_FLOAT', where: f.where, message: `“${f.name}” is a JSON number: binary floats lose cents (0.1 + 0.2), and agents copy them as they are.`, fix: 'Send amounts as decimal strings ("12.30"), or integers in minor units with that said in the description.' });
  }
  if (QTY.test(f.name) && !UNIT_WORDS.test(d) && !/\b(shares?|units?|contracts?|lots?|coins?|tokens?|base (asset|currency))\b/i.test(d)) {
    issues.push({ level: 'warn', code: 'QUANTITY_UNIT', where: f.where, message: `“${f.name}” is a quantity without its unit (shares, contracts, lots, base-asset units).`, fix: 'Say what one unit is, and whether fractions are allowed.' });
  }
  if (TIME.test(f.name) && !/(_id|Id)$/.test(f.name)) {
    const fmt = str(f.schema.format);
    const integerTime = type.includes('integer') || type.includes('number');
    if (integerTime && !/epoch|unix|seconds|milliseconds|nanoseconds/i.test(d)) issues.push({ level: 'fail', code: 'TIME_EPOCH_UNIT', where: f.where, message: `“${f.name}” is a number with no unit: seconds, milliseconds and nanoseconds since the epoch are all common.`, fix: 'Say "Unix time in milliseconds (UTC)", or use an RFC 3339 string.' });
    else if (!integerTime && fmt !== 'date-time' && fmt !== 'date' && !TZ_WORDS.test(d)) issues.push({ level: 'warn', code: 'TIME_ZONE', where: f.where, message: `“${f.name}” is a time with no format or time zone: an agent will guess, and a trading day boundary is where guesses go wrong.`, fix: 'Use format date-time (RFC 3339 with an offset), or say the time zone in the description.' });
    if (fmt === 'date' && /(settle|value|trade|ex|record|pay)/i.test(f.name) && !/\b(exchange|local|market|calendar|business)\b/i.test(d)) issues.push({ level: 'info', code: 'DATE_CALENDAR', where: f.where, message: `“${f.name}” is a date: say whose calendar (the exchange’s, the settlement system’s).`, fix: 'Name the calendar or market the date belongs to.' });
  }
  for (const [name, said, what] of STANDARD) if (name.test(f.name) && !said.test(d) && !f.schema.enum) issues.push({ level: 'warn', code: 'IDENTIFIER_STANDARD', where: f.where, message: `“${f.name}” doesn’t say it is a ${what}.`, fix: `Say so in the description, and add the pattern, so agents send the right form.` });
  if (Array.isArray(f.schema.enum) && f.schema.enum.length > 2 && str(f.schema.description).length < 20) issues.push({ level: 'warn', code: 'ENUM_UNEXPLAINED', where: f.where, message: `“${f.name}” lists ${f.schema.enum.length} values without saying what each means.`, fix: 'Describe each value (for order types and statuses, what happens next).' });
  const key = f.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (ISO_NAMES[key]) iso.push({ field: f.name, where: f.where, iso: ISO_NAMES[key] });
}

const scoreOf = (issues: Issue[], units: number) => Math.max(0, Math.round(100 - (100 * (issues.filter((i) => i.level === 'fail').length * 3 + issues.filter((i) => i.level === 'warn').length)) / Math.max(units * 3, 1)));

const summarise = (issues: Issue[], codes: [string, string][]) =>
  codes.map(([code, title]) => {
    const mine = issues.filter((i) => i.code === code);
    const level: Level = mine.some((i) => i.level === 'fail') ? 'fail' : mine.some((i) => i.level === 'warn') ? 'warn' : mine.length ? 'info' : 'pass';
    return { code, title, level, detail: mine.length ? `${mine.length} place${mine.length === 1 ? '' : 's'}: ${mine.slice(0, 3).map((i) => i.where).join(', ')}${mine.length > 3 ? '…' : ''}` : 'Nothing found.' };
  });

const OPENAPI_CHECKS: [string, string][] = [
  ['NO_DESCRIPTION', 'Operations say what they do'],
  ['NO_OPERATION_ID', 'Operations have stable names (operationId)'],
  ['PARAM_UNDESCRIBED', 'Parameters are described'],
  ['AMOUNT_UNIT', 'Amounts say their currency and unit'],
  ['AMOUNT_FLOAT', 'Amounts are not binary floats'],
  ['QUANTITY_UNIT', 'Quantities say their unit'],
  ['TIME_EPOCH_UNIT', 'Numeric times say their unit'],
  ['TIME_ZONE', 'Times carry a time zone'],
  ['IDENTIFIER_STANDARD', 'Identifiers name their standard'],
  ['ENUM_UNEXPLAINED', 'Enumerations are explained'],
  ['NO_ERROR_RESPONSES', 'Errors are described'],
  ['NO_RATE_LIMIT', 'Rate limits are described (429)'],
  ['NO_IDEMPOTENCY', 'Calls that move money take an idempotency key'],
  ['NO_AUTH', 'Authentication is described'],
];

export function checkOpenApi(spec: Obj): Result {
  const issues: Issue[] = [];
  const iso: Result['iso20022'] = [];
  const resolve = (ref: string): Obj | null => {
    if (!ref.startsWith('#/')) return null;
    let cur: unknown = spec;
    for (const p of ref.slice(2).split('/')) cur = isObj(cur) ? cur[p.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    return isObj(cur) ? cur : null;
  };
  const deref = (v: unknown): Obj => (isObj(v) && typeof v.$ref === 'string' ? resolve(v.$ref) ?? {} : isObj(v) ? v : {});
  let operations = 0;
  let fields = 0;
  let any429 = false;
  const paths = isObj(spec.paths) ? spec.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const op = item[method];
      if (!isObj(op)) continue;
      operations++;
      const where = `${method.toUpperCase()} ${path}`;
      const desc = `${str(op.summary)} ${str(op.description)}`.trim();
      if (desc.length < 20) issues.push({ level: 'fail', code: 'NO_DESCRIPTION', where, message: 'No summary or description an agent could choose this call by.', fix: 'Say in a sentence what it does, what it changes and what it returns.' });
      if (!str(op.operationId)) issues.push({ level: 'warn', code: 'NO_OPERATION_ID', where, message: 'No operationId: tools generated from the spec get unstable names.', fix: 'Add a short verb_noun operationId, such as create_order.' });
      const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])].map(deref);
      for (const p of params) {
        fields++;
        const name = str(p.name);
        if (str(p.description).length < 8) issues.push({ level: 'warn', code: 'PARAM_UNDESCRIBED', where: `${where} ${str(p.in)} ${name}`, message: `Parameter “${name}” has no description.`, fix: 'Say what it is, its unit or format, and its default.' });
        if (p.in === 'body') {
          // Swagger 2: the body is a parameter.
          const fs = fieldsOf(p.schema, where, resolve);
          fields += fs.length;
          for (const f of fs) fieldIssues(f, fs.map((x) => x.name), issues, iso);
          continue;
        }
        fieldIssues({ name, where: `${where} ${str(p.in)} ${name}`, schema: { ...deref(p.schema), description: `${str(p.description)} ${str(deref(p.schema).description)}` } }, params.map((x) => str(x.name)), issues, iso);
      }
      const bodies = [deref(op.requestBody)].filter((b) => isObj(b.content)).flatMap((b) => Object.values(b.content as Obj).map((m) => (isObj(m) ? m.schema : undefined)));
      const responses = isObj(op.responses) ? op.responses : {};
      const ok = Object.entries(responses).filter(([c]) => /^2/.test(c)).flatMap(([, r]) => Object.values(deref(r).content ?? {}).map((m) => (isObj(m) ? m.schema : undefined)));
      for (const s of [...bodies, ...ok]) {
        const fs = fieldsOf(s, where, resolve);
        fields += fs.length;
        for (const f of fs) fieldIssues(f, fs.filter((x) => x.where.slice(0, x.where.lastIndexOf('.')) === f.where.slice(0, f.where.lastIndexOf('.'))).map((x) => x.name), issues, iso);
      }
      const errs = Object.keys(responses).filter((c) => /^[45]|default/.test(c));
      if (!errs.length) issues.push({ level: 'fail', code: 'NO_ERROR_RESPONSES', where, message: 'No error responses: an agent can’t tell a bad request from a rejected order or a retryable outage.', fix: 'Describe the 4xx and 5xx answers, with a machine-readable code and a message.' });
      if (responses['429']) any429 = true;
      const headers = params.filter((p) => p.in === 'header').map((p) => str(p.name).toLowerCase());
      if ((method === 'post' || method === 'put') && MOVES_MONEY.test(path + ' ' + str(op.operationId)) && !headers.some((h) => /idempotenc|client[-_]?order[-_]?id|request[-_]?id/.test(h)) && !fieldsOf(bodies[0], where, resolve).some((f) => /idempotenc|client_?order_?id|clientOrderId|request_?id/i.test(f.name))) {
        issues.push({ level: 'fail', code: 'NO_IDEMPOTENCY', where, message: 'This call moves money or places an order, and takes no idempotency key: an agent that retries after a timeout can do it twice.', fix: 'Accept an Idempotency-Key header (or a client order id) and document what a repeat returns.' });
      }
    }
  }
  if (operations && !any429) issues.push({ level: 'warn', code: 'NO_RATE_LIMIT', where: 'paths', message: 'No 429 response anywhere: agents don’t learn the rate limit or how long to wait.', fix: 'Document 429 with a Retry-After header and the limits.' });
  const comps = isObj(spec.components) ? spec.components : {};
  if (!isObj(comps.securitySchemes) || !Object.keys(comps.securitySchemes).length) issues.push({ level: 'warn', code: 'NO_AUTH', where: 'components.securitySchemes', message: 'No security scheme: agents don’t know how to authenticate.', fix: 'Describe the scheme (API key header, OAuth 2 scopes) and which calls need it.' });
  const info = isObj(spec.info) ? spec.info : {};
  return {
    kind: 'openapi',
    title: str(info.title) || 'OpenAPI description',
    counted: { operations, fields },
    checks: summarise(issues, OPENAPI_CHECKS),
    issues,
    score: scoreOf(issues, operations + fields / 4),
    iso20022: dedupeIso(iso),
  };
}

const dedupeIso = (iso: Result['iso20022']) => [...new Map(iso.map((x) => [x.field, x])).values()].slice(0, 40);

const MCP_CHECKS: [string, string][] = [
  ['TOOL_NAME', 'Tool names are short and stable'],
  ['NO_DESCRIPTION', 'Tools say what they do'],
  ['PARAM_UNDESCRIBED', 'Arguments are described'],
  ['NO_SCHEMA', 'Tools have an input schema'],
  ['AMOUNT_UNIT', 'Amounts say their currency and unit'],
  ['AMOUNT_FLOAT', 'Amounts are not binary floats'],
  ['QUANTITY_UNIT', 'Quantities say their unit'],
  ['TIME_EPOCH_UNIT', 'Numeric times say their unit'],
  ['TIME_ZONE', 'Times carry a time zone'],
  ['IDENTIFIER_STANDARD', 'Identifiers name their standard'],
  ['ENUM_UNEXPLAINED', 'Enumerations are explained'],
  ['NOT_MARKED_DESTRUCTIVE', 'Tools that trade or pay are marked destructive'],
  ['NO_ANNOTATIONS', 'Read-only tools say so'],
];

export function checkMcpTools(input: unknown): Result {
  const tools = (Array.isArray(input) ? input : isObj(input) && Array.isArray(input.tools) ? input.tools : isObj(input) && isObj(input.result) && Array.isArray(input.result.tools) ? input.result.tools : []) as unknown[];
  const issues: Issue[] = [];
  const iso: Result['iso20022'] = [];
  let fields = 0;
  for (const t of tools.filter(isObj)) {
    const name = str(t.name);
    const where = `tool ${name || '(no name)'}`;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) issues.push({ level: 'fail', code: 'TOOL_NAME', where, message: 'The name is missing, too long or has characters clients reject.', fix: 'Use 1–64 letters, digits, _ or -, such as place_order.' });
    const desc = str(t.description);
    if (desc.length < 40) issues.push({ level: 'fail', code: 'NO_DESCRIPTION', where, message: `The description is ${desc.length ? 'too short' : 'missing'}: the model picks tools by it.`, fix: 'Say what it does, what it changes, what it returns, and when not to use it.' });
    const schema = isObj(t.inputSchema) ? t.inputSchema : null;
    if (!schema) issues.push({ level: 'fail', code: 'NO_SCHEMA', where, message: 'No inputSchema.', fix: 'Add a JSON Schema object for the arguments, even an empty one.' });
    const props = schema && isObj(schema.properties) ? schema.properties : {};
    for (const [p, s] of Object.entries(props)) {
      fields++;
      const so = isObj(s) ? s : {};
      if (str(so.description).length < 8) issues.push({ level: 'warn', code: 'PARAM_UNDESCRIBED', where: `${where}.${p}`, message: `Argument “${p}” has no description.`, fix: 'Say what it is, its unit or format, and an example.' });
      fieldIssues({ name: p, where: `${where}.${p}`, schema: so }, Object.keys(props), issues, iso);
    }
    const ann = isObj(t.annotations) ? t.annotations : null;
    const moves = MOVES_MONEY.test(name);
    if (moves && ann?.readOnlyHint !== true && ann?.destructiveHint !== true) issues.push({ level: 'fail', code: 'NOT_MARKED_DESTRUCTIVE', where, message: 'It looks like it trades or pays, but isn’t marked destructive, so clients won’t ask before running it.', fix: 'Set annotations.destructiveHint true (and idempotentHint), and say in the description that it can’t be undone.' });
    if (!moves && !ann) issues.push({ level: 'info', code: 'NO_ANNOTATIONS', where, message: 'No annotations: clients can’t tell a read from a change.', fix: 'Set annotations.readOnlyHint true on tools that only read.' });
  }
  return {
    kind: 'mcp',
    title: `${tools.length} MCP tool${tools.length === 1 ? '' : 's'}`,
    counted: { operations: tools.length, fields },
    checks: summarise(issues, MCP_CHECKS),
    issues,
    score: scoreOf(issues, tools.length + fields / 4),
    iso20022: dedupeIso(iso),
  };
}

/** JSON text in: an OpenAPI 3.x / Swagger 2 description, or an MCP tools/list result. YAML is not read here. */
export function checkAgentReadiness(text: string): Result | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: /^\s*(openapi|swagger)\s*:/m.test(text) ? 'That looks like YAML. Send the JSON form (for example: npx @redocly/cli bundle openapi.yaml --ext json).' : 'That is not JSON: send an OpenAPI description or an MCP tools/list result.' };
  }
  if (isObj(v) && (typeof v.openapi === 'string' || typeof v.swagger === 'string') && isObj(v.paths)) return checkOpenApi(v);
  if (Array.isArray(v) || (isObj(v) && (Array.isArray(v.tools) || (isObj(v.result) && Array.isArray(v.result.tools))))) return checkMcpTools(v);
  return { error: 'Not an OpenAPI description (no "openapi" and "paths") or an MCP tools/list result (no "tools").' };
}

// ---- fetching (the API and the MCP tool; the checks above stay pure) ----

export const MAX_SPEC = 5_000_000;
type F = typeof fetch;

/** An OpenAPI description at a public URL (checkUrl in audit.ts decides what is public). */
export async function fetchSpec(u: URL, f: F = fetch): Promise<{ text: string } | { error: string }> {
  const r = await f(u.toString(), { headers: { accept: 'application/json, */*', 'user-agent': 'IoMarkets-Agent-Readiness/1.0 (+https://iomarkets.tech/agent-ready)' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r) return { error: 'The description could not be fetched.' };
  if (!r.ok) return { error: `The description answered HTTP ${r.status}.` };
  const text = await r.text();
  return text.length > MAX_SPEC ? { error: `The description is over ${MAX_SPEC.toLocaleString('en')} characters.` } : { text };
}

/** The JSON-RPC answer from a Streamable HTTP MCP server, which may come as JSON or as an event stream. */
async function rpcAnswer(r: Response): Promise<Obj | null> {
  const text = (await r.text()).slice(0, MAX_SPEC);
  if ((r.headers.get('content-type') ?? '').includes('event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const m = JSON.parse(line.slice(5).trim()) as Obj;
        if ('result' in m || 'error' in m) return m;
      } catch {
        // next event
      }
    }
    return null;
  }
  try {
    return JSON.parse(text) as Obj;
  } catch {
    return null;
  }
}

/** A remote MCP server's tool list: initialize, initialized, then tools/list, as any client would. No tool is called. */
export async function fetchMcpTools(u: URL, f: F = fetch): Promise<{ tools: unknown[]; server: string } | { error: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
  const call = (body: unknown) => f(u.toString(), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'iomarkets-agent-readiness', version: '1.0.0' } } });
  if (!init) return { error: 'The MCP server could not be reached.' };
  if (init.status === 401 || init.status === 403) return { error: 'The MCP server wants authentication; paste its tools/list result instead.' };
  if (!init.ok) return { error: `The MCP server answered HTTP ${init.status} to initialize.` };
  const session = init.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  const hello = await rpcAnswer(init);
  const info = isObj(hello?.result) && isObj((hello!.result as Obj).serverInfo) ? ((hello!.result as Obj).serverInfo as Obj) : {};
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (!list?.ok) return { error: `The MCP server answered HTTP ${list?.status ?? 'nothing'} to tools/list.` };
  const out = await rpcAnswer(list);
  const tools = isObj(out?.result) && Array.isArray((out!.result as Obj).tools) ? ((out!.result as Obj).tools as unknown[]) : null;
  return tools ? { tools, server: str(info.title) || str(info.name) || u.host } : { error: 'The MCP server sent no tool list.' };
}
