# Notice Publisher

Issuers publish their own corporate action notices (dividends, splits, reverse splits, mergers) and token contract
addresses as **signed, machine-readable records** at a stable URL that AI engines, agents and wallets can read and
check. The notice itself is the open [corporate action notice format](https://iomarkets.org/formats#corporate-action-notice.v1)
(CC0).

**Trust model:** the issuer signs (ed25519), the host only stores and verifies. The host holds no key that can write for
an issuer. A record's signature proves it is the issuer's; it does not prove what the issuer states is true.

This folder is the pure core: dependency-light (only `@noble/ed25519` and WebCrypto), the same code in Node, Workers and
the browser. The hosted service at https://iomarkets.tech/publish uses it; you can run your own.

## Integrate in 5 minutes

1. **Make a key** at https://iomarkets.tech/publish (it is made in your browser and never sent), or in code:
   ```ts
   import { generateKeypair } from './publisher/src/index.ts';
   const { privateKey, publicKey } = await generateKeypair();
   ```
2. **Register** (signed with the key, which proves you hold it):
   ```ts
   const reg = { v: 1, id: 'acme-bank', name: 'Acme Bank plc', domain: 'investor.acme.com', publicKey };
   await fetch('https://iomarkets.tech/api/publisher', { method: 'POST', body: JSON.stringify({ action: 'register', ...(await signRegistration(reg, privateKey)) }) });
   ```
3. **Prove the domain.** Serve `{ "issuer": "acme-bank", "publicKey": "<key>" }` at
   `https://investor.acme.com/.well-known/iomarkets-issuer.json`, then `POST { "action": "verify_domain", "issuer": "acme-bank" }`.
   Until then your page says "domain not verified" (and it is re-checked later, see Domain re-verification). The fetch is http(s) on 80/443 only, a public host name (no IP
   literals), redirects kept on your site, 10 s, 2 MB.
4. **Publish.** A record is the next link in your chain: `seq` 1, 2, 3 and `prev`, the SHA-256 of the previous record.
   ```ts
   const head = (await (await fetch('https://iomarkets.tech/api/publisher/acme-bank.json')).json()).head; // null before the first
   const record = nextRecord('acme-bank', head, [
     { id: 'q4-2026-dividend', action: 'publish', notice: buildNotice({ issuerName: 'Acme Bank plc', eventType: 'dividend', announced: '2026-12-01', exDate: '2026-12-10', amount: '0.27', currency: 'USD' }) },
   ]);
   await fetch('https://iomarkets.tech/api/publisher', { method: 'POST', body: JSON.stringify({ action: 'publish', ...(await signRecord(record, privateKey)) }) });
   ```
   Entries are `publish` (a notice or a `{ chain, address, symbol? }` contract), `amend` (new content, `target` = the entry it
   replaces) or `retract` (`target` and a `reason`). Ids are never reused. Nothing is edited in place: the old entry stays, marked
   amended or retracted, and the history shows it.
5. **Paste what the page gives you:** JSON-LD for your investor relations page, a line for `llms.txt`, a hint for
   `robots.txt` (`jsonLd`, `llmsTxt`, `robotsTxt` in `generate.ts`, also in the `snippets` of the JSON below).

## Reading

- `GET /api/publisher/<id>.json`: issuer, domain status, current state, every signed record. CORS, cached 60 s.
- `GET /api/publisher/<id>/feed.xml`: Atom, newest first, retractions included.
- `https://iomarkets.tech/issuer/<id>`: a page that checks every signature in your browser.
- MCP (`https://iomarkets.tech/mcp`): `get_issuer_notices`, `verify_issuer_publication` (read-only).

To verify by hand: for each record, the signature is ed25519 over the UTF-8 text `iomarkets-issuer-publication/1/record\n`
followed by the record's canonical JSON (keys sorted at every level, no spaces); `prev` of record n+1 is the SHA-256 (hex)
of record n's canonical JSON. `verifyChain(id, rootPublicKey, records)` does all of it, including key rotations (below).
`rootPublicKey` is the key the issuer registered with (`issuer.publicKey` in the JSON); later keys come from the chain itself.

## Key rotation and compromise

A key is replaced by a **rotation record** in the same chain: it has the next `seq` and `prev` like any record, no entries,
and `"rotation": { "newKey": "<64 hex, lower case>", "effectiveFrom": <its own seq + 1> }`. It carries two signatures:

- `sig`: the key in force, over the record (the normal record signature),
- `sig2`: the **new** key, over the UTF-8 text `iomarkets-issuer-publication/1/rotation-accept\n` followed by the same canonical JSON
  (a different tag, so one signature can never pass as the other).

A rotation signed by only one of the two keys is refused (`401`). Records from `effectiveFrom` on must be signed with the new
key; a record signed with the old key after the rotation is refused. To verify a chain: start from the root key, check each
record against the key in force at its `seq`, and at a rotation record check both signatures, then switch keys. A key is never
reused. Earlier records stay verifiable: nothing is rewritten.

```ts
const rec = rotationRecord('acme-bank', head, newPublicKey, { /* compromisedAfterSeq?: n, reason?: '...' */ });
await fetch('https://iomarkets.tech/api/publisher', { method: 'POST', body: JSON.stringify({ action: 'publish', ...(await signRotation(rec, oldPrivateKey, newPrivateKey)) }) });
```

**Compromise.** Add `compromisedAfterSeq: n` and a `reason` to the rotation: the old key is declared compromised, and its
records after seq `n` (but not before the key took over) are marked `untrusted` in the state. They are not deleted: the history
still shows them, the page and MCP tools flag them, and they are left out of the generated JSON-LD. This is the issuer's
statement; IoMarkets cannot know which records were forged. If the old key is lost (not stolen) you cannot sign the rotation
and must register a new id.

Reading: `GET /api/publisher/<id>.json` has `keys` (every key, the seq it took over, `revoked` if declared compromised),
`revocations`, and `issuer.currentKey` next to `issuer.publicKey` (the root). The file at your domain should carry the key in
force; it may also list older keys in `publicKeys`.

## Domain re-verification

Verification is not permanent. Anyone may `POST { "action": "recheck_domain", "issuer": "<id>" }`; the issuer's page does so
when the last check is over a day old. It re-fetches the well-known file (same fetch rules as above) and compares it with the
key in force. Success refreshes `verifiedAt` and clears the failure count. A failure is counted (`recheck.failures`,
`recheck.firstFailure`); after **3 failures spread over at least 7 days** the issuer is marked unverified and the domain is
free for another issuer to claim. Limits: one counted check per issuer per hour, and the per-visitor daily cap on domain checks.

Rotation and re-checks need migration `0014_publisher_rotation.sql`; until it is applied the API answers 503 naming it, and
everything else works as before.

## Limits

20 entries and 32,000 characters per record, 200 records per issuer, 60,000 characters per request; daily caps on
registrations, domain checks and publications. Lose the key (not just rotate it) and you register a new id.
