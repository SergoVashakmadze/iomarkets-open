// The AI-readiness audit for issuers: can AI search engines and agents read an investor relations or token issuer
// page, and does it state its facts in a form they can't get wrong? Pure: it works on the texts the caller fetched
// (the page, /robots.txt, /llms.txt). Checks, each pass / warn / fail with a fix:
//   - robots.txt: which AI crawlers may fetch the page (search and answer bots matter most: blocking them keeps the
//     page out of AI answers; blocking training bots is the issuer's choice and only noted);
//   - llms.txt at the site root;
//   - the page itself: text in the HTML (not only after JavaScript), title, description, no noindex / nosnippet;
//   - structured data: schema.org JSON-LD for the issuer, and corporate action notices (notice.ts), checked against
//     the feed;
//   - with a subject, whether the page's own text states the latest facts correctly (the AI answer check's grader).
// It then writes the fixes: the JSON-LD (issuer plus a notice per feed event), an llms.txt draft and robots.txt lines.

import { CHAINS } from '../../assetmap/src/index.ts';
import { questionsFor, gradeAll, score, type Finding, type Score, type Subject } from './check.ts';
import { compareNotice, NOTICE_TYPE, noticeScript, toNotice } from './notice.ts';

export type Level = 'pass' | 'warn' | 'fail' | 'info';
export type Check = { id: string; title: string; level: Level; detail: string; fix?: string };

/** AI crawlers by user-agent token, and what blocking each one costs. */
export const AI_BOTS: { token: string; who: string; kind: 'search' | 'user' | 'training' }[] = [
  { token: 'OAI-SearchBot', who: 'ChatGPT search', kind: 'search' },
  { token: 'ChatGPT-User', who: 'ChatGPT, fetching a page a user asked about', kind: 'user' },
  { token: 'GPTBot', who: 'OpenAI model training', kind: 'training' },
  { token: 'PerplexityBot', who: 'Perplexity search', kind: 'search' },
  { token: 'Perplexity-User', who: 'Perplexity, fetching a page a user asked about', kind: 'user' },
  { token: 'Googlebot', who: 'Google Search and AI Overviews', kind: 'search' },
  { token: 'Google-Extended', who: 'Gemini training and grounding', kind: 'training' },
  { token: 'Bingbot', who: 'Bing and Microsoft Copilot', kind: 'search' },
  { token: 'Claude-SearchBot', who: 'Claude search', kind: 'search' },
  { token: 'Claude-User', who: 'Claude, fetching a page a user asked about', kind: 'user' },
  { token: 'ClaudeBot', who: 'Anthropic model training', kind: 'training' },
  { token: 'Applebot-Extended', who: 'Apple Intelligence training', kind: 'training' },
  { token: 'CCBot', who: 'Common Crawl (used to train many models)', kind: 'training' },
];

type Group = { agents: string[]; rules: { allow: boolean; path: string }[] };

/** robots.txt as groups of user-agents and their rules (RFC 9309). */
export function parseRobots(txt: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      if (val || key === 'allow') cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  return groups;
}

const ruleMatches = (pattern: string, path: string) => {
  if (!pattern) return false;
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
};

/** May this user-agent fetch this path? The most specific group, then the longest matching rule; allow wins a tie. */
export function allowed(groups: Group[], token: string, path: string): boolean {
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && t.startsWith(a)));
  const use = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const r of use.flatMap((g) => g.rules)) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
/** The page's visible text as served, before any JavaScript runs. */
export const textOf = (html: string) =>
  decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const meta = (html: string, name: string) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'));
  return m ? decode(m[0].match(/content=["']([^"']*)["']/i)?.[1] ?? '') : null;
};

/** Every JSON-LD object on the page, @graph flattened; a script that is not JSON is reported. */
export function jsonLdOf(html: string): { items: Record<string, unknown>[]; broken: number } {
  const items: Record<string, unknown>[] = [];
  let broken = 0;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1].trim()) as unknown;
      const add = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(add);
        else if (x && typeof x === 'object') {
          const o = x as Record<string, unknown>;
          if (Array.isArray(o['@graph'])) add(o['@graph']);
          else items.push(o);
        }
      };
      add(v);
    } catch {
      broken++;
    }
  }
  return { items, broken };
}
const typesOf = (o: Record<string, unknown>) => [o['@type']].flat().filter((t): t is string => typeof t === 'string');

export type AuditInput = {
  url: string;
  /** The page as served; null when it could not be fetched. */
  html: string | null;
  status?: number;
  /** X-Robots-Tag header, if any. */
  robotsHeader?: string | null;
  robots: string | null;
  llms: string | null;
  subject?: Subject | null;
};
export type Audit = {
  url: string;
  checks: Check[];
  grade: { pass: number; warn: number; fail: number; score: number };
  facts: { findings: Finding[]; score: Score } | null;
  fixes: { jsonLd: string | null; llmsTxt: string; robotsTxt: string | null };
};

export function audit(a: AuditInput): Audit {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const u = new URL(a.url);
  const path = u.pathname + u.search;
  const s = a.subject ?? null;

  // robots.txt
  if (a.robots === null) add({ id: 'robots', title: 'robots.txt', level: 'info', detail: 'No robots.txt at the site root: every crawler may fetch every page.' });
  const groups = parseRobots(a.robots ?? '');
  const blocked = AI_BOTS.filter((b) => !allowed(groups, b.token, path));
  const blockedSearch = blocked.filter((b) => b.kind !== 'training');
  if (a.robots !== null) {
    add(
      blockedSearch.length
        ? { id: 'robots-search', title: 'AI search crawlers', level: 'fail', detail: `robots.txt blocks ${blockedSearch.map((b) => `${b.token} (${b.who})`).join(', ')} from this page, so those engines can’t read or cite it and answer from other sites instead.`, fix: `Allow them: ${blockedSearch.map((b) => `"User-agent: ${b.token}" with "Allow: ${u.pathname}"`).join('; ')}.` }
        : { id: 'robots-search', title: 'AI search crawlers', level: 'pass', detail: 'robots.txt lets the AI search and answer crawlers (ChatGPT search, Perplexity, Google, Bing/Copilot, Claude) read this page.' },
    );
    const training = blocked.filter((b) => b.kind === 'training');
    add({ id: 'robots-training', title: 'AI training crawlers', level: 'info', detail: training.length ? `Blocks ${training.map((b) => b.token).join(', ')}: models trained later won’t learn from this page. That is the issuer’s choice and does not stop AI search from citing it.` : 'Training crawlers are allowed.' });
  }

  // llms.txt
  const llmsOk = !!a.llms && /^#\s+\S/m.test(a.llms) && /\]\(https?:\/\//.test(a.llms);
  add(
    a.llms === null
      ? { id: 'llms', title: 'llms.txt', level: 'warn', detail: 'No /llms.txt: AI agents have no short guide to the site and fall back to crawling it.', fix: 'Publish the llms.txt draft below at the site root.' }
      : llmsOk
        ? { id: 'llms', title: 'llms.txt', level: 'pass', detail: '/llms.txt is there, with a title and links.' }
        : { id: 'llms', title: 'llms.txt', level: 'warn', detail: '/llms.txt is there but has no "# Title" line or no links to pages.', fix: 'Follow https://llmstxt.org: a "# Name" line, a "> summary", then lists of [page](url): what it has.' },
  );

  // The page
  let ld: ReturnType<typeof jsonLdOf> = { items: [], broken: 0 };
  let text = '';
  if (a.html === null) {
    add({ id: 'page', title: 'The page', level: 'fail', detail: `The page could not be fetched${a.status ? ` (HTTP ${a.status})` : ''}. If crawlers get the same, AI engines can’t read it.` });
  } else {
    text = textOf(a.html);
    add(
      text.length >= 400
        ? { id: 'text', title: 'Text without JavaScript', level: 'pass', detail: `The page as served has ${text.length.toLocaleString('en')} characters of text, so crawlers that don’t run JavaScript can read it.` }
        : { id: 'text', title: 'Text without JavaScript', level: 'fail', detail: `The page as served has only ${text.length} characters of text: it is filled in by JavaScript, and most AI crawlers don’t run it.`, fix: 'Render the announcement into the HTML on the server (or prerender it), or at least add the JSON-LD below, which crawlers read without JavaScript.' },
    );
    const title = a.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const desc = meta(a.html, 'description') ?? meta(a.html, 'og:description');
    add(title && desc ? { id: 'meta', title: 'Title and description', level: 'pass', detail: `Title “${decode(title).slice(0, 90)}”, with a description.` } : { id: 'meta', title: 'Title and description', level: 'warn', detail: `${title ? 'No meta description' : 'No <title>'}: engines summarise the page without the issuer’s own words.`, fix: 'Add a <title> and <meta name="description"> that say what the page announces, with the ticker.' });
    const robotsMeta = [meta(a.html, 'robots'), a.robotsHeader].filter(Boolean).join(', ').toLowerCase();
    if (/noindex|nosnippet|noai|noimageai/.test(robotsMeta)) add({ id: 'noindex', title: 'Indexing directives', level: 'fail', detail: `The page says “${robotsMeta}”: search and AI engines are told not to index or quote it.`, fix: 'Remove noindex / nosnippet from announcements meant for investors.' });
    ld = jsonLdOf(a.html);
    if (ld.broken) add({ id: 'jsonld-broken', title: 'Structured data', level: 'fail', detail: `${ld.broken} JSON-LD block${ld.broken === 1 ? ' is' : 's are'} not valid JSON, so engines ignore ${ld.broken === 1 ? 'it' : 'them'}.`, fix: 'Check the block with any JSON validator.' });
    const org = ld.items.find((o) => typesOf(o).some((t) => /^(Organization|Corporation|FinancialService|InvestmentFund|FinancialProduct)$/.test(t)));
    add(
      org
        ? { id: 'jsonld-issuer', title: 'Issuer markup', level: org.tickerSymbol || (org as { identifier?: unknown }).identifier ? 'pass' : 'warn', detail: `schema.org ${typesOf(org).join('/')} “${String(org.name ?? '')}”${org.tickerSymbol ? `, ticker ${String(org.tickerSymbol)}` : ', without a tickerSymbol or identifier, so engines may confuse it with a similar name'}.`, ...(org.tickerSymbol ? {} : { fix: 'Add "tickerSymbol" (and the SEC CIK as an identifier) to the Corporation markup.' }) }
        : { id: 'jsonld-issuer', title: 'Issuer markup', level: 'warn', detail: 'No schema.org Corporation or Organization markup: engines guess who the page is about from the text.', fix: 'Paste the JSON-LD below.' },
    );
    const notices = ld.items.filter((o) => typesOf(o).includes(NOTICE_TYPE));
    if (!notices.length) {
      add({ id: 'notice', title: 'Corporate action notices', level: s?.events.length ? 'warn' : 'info', detail: 'No corporate action notice (iomarkets.org/formats): dividend dates and amounts are only in prose, which is where AI answers go wrong.', ...(s?.events.length ? { fix: 'Paste the notices below, generated from the company’s own SEC filings.' } : {}) });
    } else {
      const issues: string[] = [];
      for (const n of notices) {
        const match = s?.events.find((e) => e.type === n.eventType && (e.dates.pay === n.paymentDate || e.dates.effective === n.effectiveDate || e.dates.record === n.recordDate || e.dates.announced === n.announced));
        if (match) for (const d of compareNotice(n, match)) issues.push(`${d.field} says ${d.page}, the filing says ${d.feed}`);
      }
      add(issues.length ? { id: 'notice', title: 'Corporate action notices', level: 'fail', detail: `${notices.length} notice${notices.length === 1 ? '' : 's'}, but ${issues.join('; ')}.`, fix: 'Correct the notice from the filing: the generated one below matches it.' } : { id: 'notice', title: 'Corporate action notices', level: 'pass', detail: `${notices.length} notice${notices.length === 1 ? '' : 's'} in the open format${s?.events.length ? ', matching the SEC filings' : ''}.` });
    }
    if (s?.entries.length && s.asset) {
      const listed = s.entries.flatMap((e) => e.tokens).filter((t) => a.html!.toLowerCase().includes(t.address.toLowerCase()));
      add({ id: 'contracts', title: 'Token contracts on the page', level: listed.length ? 'pass' : 'warn', detail: listed.length ? `The page lists ${listed.length} of the ${s.entries.flatMap((e) => e.tokens).length} official contracts, so agents can take them from the issuer.` : 'The page lists none of the official contracts, so agents look for them elsewhere, where look-alikes are.', ...(listed.length ? {} : { fix: `List each contract with its chain (${[...new Set(s.entries.flatMap((e) => e.tokens.map((t) => CHAINS[t.chain].name)))].slice(0, 5).join(', ')}…).` }) });
    }
  }

  // The page's own facts, graded like an AI answer.
  let facts: Audit['facts'] = null;
  if (s && text) {
    const qs = questionsFor(s).filter((q) => q.id !== 'tokens');
    if (qs.length) {
      const findings = gradeAll(s, qs, text);
      facts = { findings, score: score(findings) };
      const sc = facts.score;
      add({ id: 'facts', title: 'The page’s own facts', level: sc.wrong + sc.outOfDate ? 'fail' : sc.right ? 'pass' : 'info', detail: sc.right + sc.wrong + sc.outOfDate ? `Against the SEC filing: ${sc.right} right, ${sc.wrong} wrong, ${sc.outOfDate} out of date.` : 'The page does not state the latest corporate action’s figures, so engines take them from other sites.' });
    }
  }

  // Fixes
  const site = `${u.protocol}//${u.host}`;
  const name = s?.name ?? (ld.items.find((o) => typeof o.name === 'string')?.name as string | undefined) ?? u.host;
  const latest = s?.events.slice(0, 4) ?? [];
  const org = s?.cik || s?.ticker ? { '@context': 'https://schema.org', '@type': 'Corporation', name, ...(s?.ticker ? { tickerSymbol: s.ticker } : {}), url: site, ...(s?.cik ? { identifier: { '@type': 'PropertyValue', propertyID: 'SEC CIK', value: s.cik } } : {}) } : null;
  const jsonLd = org || latest.length ? [org ? `<script type="application/ld+json">\n${JSON.stringify(org, null, 2)}\n</script>` : '', latest.length ? noticeScript(latest.map(toNotice)) : ''].filter(Boolean).join('\n') : null;
  const llmsTxt = [
    `# ${name}`,
    '',
    `> Investor information for ${name}${s?.ticker ? ` (${s.ticker})` : ''}: announcements, dividends and filings.`,
    '',
    '## Investors',
    `- [Investor relations](${a.url}): announcements, dividends and corporate actions, with the dates as filed.`,
    ...(s?.cik ? [`- [SEC filings](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${s.cik}): the company’s own filings, the primary source.`] : []),
    ...(s?.entries.length && s.asset ? [`- [Token contracts](${a.url}): the official contract for each chain.`] : []),
  ].join('\n');
  const robotsTxt = blockedSearch.length ? blockedSearch.map((b) => `User-agent: ${b.token}\nAllow: ${u.pathname}`).join('\n\n') : null;

  const n = (l: Level) => checks.filter((c) => c.level === l).length;
  const graded = n('pass') + n('warn') + n('fail');
  return {
    url: a.url,
    checks,
    grade: { pass: n('pass'), warn: n('warn'), fail: n('fail'), score: graded ? Math.round((100 * (n('pass') + n('warn') / 2)) / graded) : 0 },
    facts,
    fixes: { jsonLd, llmsTxt, robotsTxt },
  };
}

// ---- fetching (used by the API and the MCP tool; the audit above stays pure) ----

export const MAX_PAGE = 2_000_000;

/** A public http(s) URL a visitor may ask the site to read: no IP literals, no localhost, no credentials, no odd ports. */
export function checkUrl(raw: unknown): URL | { error: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return { error: 'Give the page’s address, such as https://investor.example.com/dividends.' };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return { error: 'That is not a web address.' };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Only http and https pages.' };
  if (u.username || u.password) return { error: 'No user names or passwords in the address.' };
  if (u.port && !['80', '443'].includes(u.port)) return { error: 'Only the standard ports.' };
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h)) return { error: 'Give a public site’s name, not an IP address or a local name.' };
  return u;
}

export type Fetched = { status: number; text: string | null; robotsHeader: string | null };
export type SiteFetch = (url: string) => Promise<Fetched>;

/** The page, /robots.txt and /llms.txt, each with a timeout and a size cap; redirects followed only to public hosts. */
export async function fetchSite(u: URL, f: typeof fetch = fetch): Promise<{ page: Fetched; robots: string | null; llms: string | null; finalUrl: string }> {
  const get = async (url: string, hops = 0): Promise<Fetched & { url: string }> => {
    const r = await f(url, { redirect: 'manual', headers: { 'user-agent': 'IoMarkets-AI-Readiness/1.0 (+https://iomarkets.tech/ai-readiness)', accept: 'text/html,text/plain,*/*' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r) return { status: 0, text: null, robotsHeader: null, url };
    if (r.status >= 300 && r.status < 400 && r.headers.get('location') && hops < 4) {
      const next = checkUrl(new URL(r.headers.get('location')!, url).toString());
      if ('error' in next) return { status: r.status, text: null, robotsHeader: null, url };
      return get(next.toString(), hops + 1);
    }
    if (!r.ok) return { status: r.status, text: null, robotsHeader: null, url };
    const body = await r.text().catch(() => '');
    return { status: r.status, text: body.slice(0, MAX_PAGE), robotsHeader: r.headers.get('x-robots-tag'), url };
  };
  const page = await get(u.toString());
  const root = new URL(page.url);
  const [robots, llms] = await Promise.all([get(`${root.protocol}//${root.host}/robots.txt`), get(`${root.protocol}//${root.host}/llms.txt`)]);
  // A site that serves its home page for every path would "have" an llms.txt: only plain text counts.
  const plain = (x: Fetched) => (x.text !== null && !/^\s*<(!doctype|html)/i.test(x.text) ? x.text : null);
  return { page, robots: plain(robots), llms: plain(llms), finalUrl: page.url };
}
