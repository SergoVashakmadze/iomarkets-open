// "What does this event do to my position?" Pure arithmetic over one feed event and the holder's own numbers
// (shares, cost basis). Exact decimals (BigInt, 8 places), never floating point. Only what the feed states is
// used: where the data has no figure (a merger's exchange ratio, how a fractional share is settled, a tax
// treatment) the answer says "not stated" and the filing link is the source. Not tax or investment advice.
import { keyDate } from './query.ts';
import { money, unitOf, type CorporateAction } from './types.ts';

const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);

/** Parse a plain decimal ("1,250.5" or "1250.5") to a scaled integer; null when it is not a non-negative number with up to 8 places. */
export function parseDecimal(raw: string): bigint | null {
  const s = raw.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * ONE + BigInt((m[2] ?? '').padEnd(SCALE, '0') || '0');
}

/** A scaled integer as text with `dp` places, rounded half up. */
export function fmtScaled(v: bigint, dp = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const div = 10n ** BigInt(SCALE - dp);
  const r = (a + div / 2n) / div;
  const s = r.toString().padStart(dp + 1, '0');
  const out = dp ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s;
  return (neg && r !== 0n ? '-' : '') + out;
}
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const show = (v: bigint, dp = 2) => { const t = fmtScaled(v, dp); const [i, f] = t.split('.'); return (i.startsWith('-') ? '-' : '') + group(i.replace('-', '')) + (f ? `.${f}` : ''); };

export type Holding = { shares: string; /** Total cost of the whole holding, or per share. Optional. */ cost?: string; costKind?: 'total' | 'per-share' };
export type Line = { label: string; value: string; note?: string };
export type Impact = {
  ok: boolean;
  error?: string;
  event: { id: string; type: CorporateAction['type']; company: string; ticker?: string; keyDate: string; sourceUrl: string; form: string; filed: string };
  lines: Line[];
  /** What the feed does not say that the holder may need: always read the filing for these. */
  notStated: string[];
};

const dateLines = (e: CorporateAction): Line[] => {
  const d = e.dates;
  const out: Line[] = [{ label: 'Announced', value: d.announced }];
  if (d.record) out.push({ label: 'Record date', value: d.record });
  if (d.ex) out.push({ label: 'Ex-date', value: d.ex, note: e.exDateRule ? 'Not stated in the filing: set equal to the record date under the US T+1 rule.' : undefined });
  if (d.pay) out.push({ label: 'Pay date', value: d.pay });
  if (d.effective) out.push({ label: 'Effective', value: d.effective });
  return out;
};

const costOf = (h: Holding, shares: bigint): { total: bigint; perShare: bigint } | null => {
  if (!h.cost?.trim()) return null;
  const c = parseDecimal(h.cost);
  if (c === null) return null;
  if (h.costKind === 'per-share') return { perShare: c, total: (c * shares) / ONE };
  return { total: c, perShare: shares ? (c * ONE) / shares : 0n };
};

/** Apply one event to a holding. */
export function positionImpact(e: CorporateAction, h: Holding): Impact {
  const event = { id: e.id, type: e.type, company: e.company.name, ticker: e.company.ticker, keyDate: keyDate(e), sourceUrl: e.source.url, form: e.source.form, filed: e.source.filed };
  const fail = (error: string): Impact => ({ ok: false, error, event, lines: [], notStated: [] });
  const shares = parseDecimal(h.shares);
  if (shares === null || shares === 0n) return fail('Enter the number of shares you hold: a positive number with up to 8 decimal places.');
  if (h.cost?.trim() && parseDecimal(h.cost) === null) return fail('The cost must be a positive number (up to 8 decimal places), or empty.');
  const unit = unitOf(e);
  const cost = costOf(h, shares);
  const lines: Line[] = [{ label: `You hold`, value: `${show(shares, 4).replace(/\.?0+$/, '')} ${unit}${shares === ONE ? '' : 's'}` }];
  if (cost) lines.push({ label: 'Your cost basis', value: `${show(cost.total)} total · ${show(cost.perShare, 4)} per ${unit}`, note: 'In the currency you paid; the feed does not know it.' });
  const notStated: string[] = [];

  if (e.type === 'split' || e.type === 'reverse-split') {
    if (!e.ratio) {
      notStated.push('The split ratio is not in the feed’s data for this event.');
    } else {
      const n = parseDecimal(String(e.ratio.new));
      const o = parseDecimal(String(e.ratio.old));
      if (!n || !o) return fail('The ratio in the feed is not a plain number.');
      const after = (shares * n) / o; // scaled 8 dp, truncated
      const whole = after / ONE;
      const frac = after % ONE;
      lines.push({ label: 'Split ratio', value: `${e.ratio.new} new for ${e.ratio.old} old` + (e.type === 'reverse-split' ? ' (reverse split: fewer shares)' : ' (forward split: more shares)') });
      lines.push({ label: `${unit}s after`, value: frac === 0n ? show(whole * ONE, 0) : `${show(whole * ONE, 0)} whole + ${fmtScaled(frac, 4)} of a ${unit}`, note: frac === 0n ? undefined : `${fmtScaled(after, 4)} ${unit}s before any fraction is dealt with.` });
      if (frac !== 0n) notStated.push(`How the fractional ${unit} is settled (cash in lieu, rounding up or down) is in the filing, not in the feed’s data.`);
      if (cost) {
        lines.push({ label: 'Cost basis after', value: `${show(cost.total)} total (unchanged) · ${show((cost.total * o * ONE) / (shares * n), 4)} per ${unit}`, note: 'The split itself does not change what you paid in total, only how many shares it is spread over. Tax treatment is not covered here.' });
      }
    }
  } else if (e.type === 'dividend') {
    if (!e.cash) {
      notStated.push('The dividend amount is not in the feed’s data for this event.');
    } else {
      const amt = parseDecimal(e.cash.amount);
      if (amt !== null) {
        const gross = (shares * amt) / ONE;
        lines.push({ label: `Dividend per ${unit}`, value: money(e.cash) });
        lines.push({ label: 'Cash for your holding', value: `${e.cash.currency} ${show(gross)}`, note: 'Gross: before any withholding tax or broker fee, and only if you hold the shares on the ex-date rule below.' });
        if (cost && cost.perShare > 0n) lines.push({ label: 'Yield on your cost, this payment', value: `${fmtScaled((amt * 100n * ONE) / cost.perShare, 2)}%`, note: 'Dividend per share divided by your cost per share, if the two are in the same currency.' });
      }
    }
    lines.push(...dateLines(e));
    lines.push({ label: 'To receive it', value: e.dates.ex ? `Own the ${unit} before the ex-date (${e.dates.ex}).` : 'The feed gives no ex-date.', note: 'Buying on or after the ex-date does not carry the dividend.' });
    if (e.frequency) lines.push({ label: 'Frequency', value: e.frequency });
  } else {
    lines.push({ label: 'Acquirer', value: e.acquirer ?? 'not stated' });
    if (e.cash) {
      const amt = parseDecimal(e.cash.amount);
      if (amt !== null) {
        const total = (shares * amt) / ONE;
        lines.push({ label: `Cash per ${unit}`, value: money(e.cash) });
        lines.push({ label: 'Cash for your holding', value: `${e.cash.currency} ${show(total)}`, note: 'Gross consideration as the filing states it, before tax and fees; whether it has been paid yet is in the filing.' });
        if (cost) lines.push({ label: 'Against your cost', value: `${total >= cost.total ? '+' : '-'}${e.cash.currency} ${show(total >= cost.total ? total - cost.total : cost.total - total)}`, note: 'Simple difference between the cash and what you paid, in the same currency. Not a tax calculation.' });
      }
    }
    const rn = e.ratio ? parseDecimal(String(e.ratio.new)) : null;
    const ro = e.ratio ? parseDecimal(String(e.ratio.old)) : null;
    if (e.ratio && rn && ro) lines.push({ label: 'Exchange ratio', value: `${e.ratio.new} acquirer share(s) per ${e.ratio.old} of yours`, note: `Acquirer shares you would receive: ${fmtScaled((shares * rn) / ro, 4)}.` });
    else lines.push({ label: 'Exchange ratio', value: 'not stated' });
    if (!e.cash && !e.ratio) notStated.push('The merger consideration (cash per share, or an exchange ratio) is not in the feed’s data for this event: read the filing.');
    else if (!e.ratio) notStated.push('If part of the consideration is paid in acquirer shares, that ratio is not in the feed’s data.');
    lines.push(...dateLines(e));
  }
  return { ok: true, event, lines, notStated };
}

/** Events for what someone typed: a ticker, CIK or FIGI exactly, or a part of the company name. Newest key date first. */
export function findEvents(events: CorporateAction[], text: string, limit = 30): CorporateAction[] {
  const t = text.trim().toLowerCase();
  if (!t) return [];
  const exact = events.filter((e) => e.company.ticker?.toLowerCase() === t || e.company.cik.replace(/^0+/, '') === t.replace(/^0+/, '') || e.company.figi?.toLowerCase() === t);
  const hits = exact.length ? exact : t.length >= 3 ? events.filter((e) => e.company.name.toLowerCase().includes(t)) : [];
  return [...hits].sort((a, b) => keyDate(b).localeCompare(keyDate(a))).slice(0, limit);
}
