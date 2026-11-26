import crypto from 'node:crypto';
import dns from 'node:dns';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { decryptSecret, encryptSecret } from '../security/crypto.js';

export interface DnsRecordCheckResult {
  recordType: 'TXT_VERIFY' | 'MX' | 'A' | 'AAAA' | 'PTR' | 'SPF' | 'DKIM' | 'DMARC';
  label: string;
  host: string;
  expectedValue: string;
  actualValues: string[];
  status: 'verified' | 'mismatch' | 'missing' | 'dns_unreachable';
  lastCheckedAt: string | null;
  error?: string;
  recommendedAction: string;
}

export interface HostedDomainRecord {
  id: string;
  domain: string;
  status: 'pending_verification' | 'active' | 'disabled';
  ownershipVerified: boolean;
  internalOnly: boolean;
  verificationToken: string;
  dkimSelector: string;
  dkimPublicKey: string;
  primaryMxHost: string;
  spfExpected: string;
  dmarcExpected: string;
  verifiedAt: string | null;
  lastDnsCheckAt: string | null;
  dnsChecks: DnsRecordCheckResult[];
  expectedRecords: Array<{
    recordType: string;
    host: string;
    ttl: number;
    priority?: number;
    value: string;
    notes: string;
  }>;
  mailboxCount: number;
  aliasCount: number;
  createdAt: string;
  updatedAt: string;
}

const DOMAIN_FQDN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function generateDkimKeyPair(): { publicKeyBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const stripped = publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  return { publicKeyBase64: stripped, privateKeyPem: privateKey };
}

export function buildExpectedDnsRecords(row: {
  domain: string;
  verification_token: string;
  dkim_selector: string;
  dkim_public_key: string;
  primary_mx_host: string;
  spf_expected: string;
  dmarc_expected: string;
}) {
  const mxHost = row.primary_mx_host || `mail.${row.domain}`;
  return [
    {
      recordType: 'TXT',
      host: `_cadence-verify.${row.domain}`,
      ttl: 300,
      value: `cadence-verify=${row.verification_token}`,
      notes: 'Proves administrative ownership of this domain before public activation.',
    },
    {
      recordType: 'MX',
      host: row.domain,
      ttl: 3600,
      priority: 10,
      value: mxHost,
      notes: 'Routes incoming Internet email to your Cadence SMTP MX server (TCP/25).',
    },
    {
      recordType: 'A / AAAA',
      host: mxHost,
      ttl: 3600,
      value: '<YOUR_SERVER_PUBLIC_IPV4>',
      notes: 'Points your mail server hostname to your server static public IP (and matching IPv6 if enabled).',
    },
    {
      recordType: 'TXT (SPF)',
      host: row.domain,
      ttl: 3600,
      value: row.spf_expected,
      notes: 'Authorizes your MX host IP to send mail for this domain.',
    },
    {
      recordType: 'TXT (DKIM)',
      host: `${row.dkim_selector}._domainkey.${row.domain}`,
      ttl: 3600,
      value: `v=DKIM1; k=rsa; p=${row.dkim_public_key}`,
      notes: 'Publishes the 2048-bit RSA public key matching Cadence outbound DKIM signatures.',
    },
    {
      recordType: 'TXT (DMARC)',
      host: `_dmarc.${row.domain}`,
      ttl: 3600,
      value: row.dmarc_expected,
      notes: 'Instructs receiving providers how to handle SPF/DKIM alignment failures.',
    },
    {
      recordType: 'PTR (Reverse DNS)',
      host: '<YOUR_SERVER_PUBLIC_IP>',
      ttl: 3600,
      value: mxHost,
      notes: 'Configured with your VPS/cloud hosting provider so receiving MTAs verify reverse DNS matches HELO/EHLO.',
    },
  ];
}

function formatDomainRow(db: DatabaseSync, row: Record<string, any>): HostedDomainRecord {
  const mailboxCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM accounts WHERE domain_id = ? AND provider_type IN ('hosted', 'local')").get(row.id) as {
      cnt: number;
    }
  ).cnt;
  const aliasCount = (db.prepare('SELECT COUNT(*) AS cnt FROM mailbox_aliases WHERE domain_id = ?').get(row.id) as { cnt: number }).cnt;
  let dnsChecks: DnsRecordCheckResult[] = [];
  try {
    const parsed = JSON.parse(row.last_dns_report_json || '{}');
    if (Array.isArray(parsed.checks)) dnsChecks = parsed.checks;
  } catch {
    dnsChecks = [];
  }

  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    ownershipVerified: Boolean(row.ownership_verified),
    internalOnly: Boolean(row.internal_only),
    verificationToken: row.verification_token,
    dkimSelector: row.dkim_selector,
    dkimPublicKey: row.dkim_public_key,
    primaryMxHost: row.primary_mx_host,
    spfExpected: row.spf_expected,
    dmarcExpected: row.dmarc_expected,
    verifiedAt: row.verified_at || null,
    lastDnsCheckAt: row.last_dns_check_at || null,
    dnsChecks,
    expectedRecords: buildExpectedDnsRecords(row as any),
    mailboxCount,
    aliasCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listHostedDomains(db: DatabaseSync = getDb()): HostedDomainRecord[] {
  const rows = db.prepare('SELECT * FROM domains ORDER BY created_at DESC').all() as Array<Record<string, any>>;
  return rows.map((r) => formatDomainRow(db, r));
}

export function listPublicActiveDomains(db: DatabaseSync = getDb()): Array<{ id: string; domain: string; ownershipVerified: boolean; internalOnly: boolean }> {
  const rows = db
    .prepare("SELECT id, domain, ownership_verified, internal_only FROM domains WHERE status = 'active' ORDER BY domain ASC")
    .all() as Array<{ id: string; domain: string; ownership_verified: number; internal_only: number }>;
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    ownershipVerified: Boolean(r.ownership_verified),
    internalOnly: Boolean(r.internal_only),
  }));
}

export function createHostedDomain(
  db: DatabaseSync,
  createdByUserId: string | null,
  domainInput: string,
  opts: { primaryMxHost?: string; dkimSelector?: string; activateInternal?: boolean } = {}
): HostedDomainRecord {
  const domain = domainInput.trim().toLowerCase().replace(/^\*@?/, '');
  if (!DOMAIN_FQDN_RE.test(domain)) {
    throw new Error('Enter a valid fully-qualified domain name (e.g. example.com or mail.local)');
  }

  const existing = db.prepare('SELECT id FROM domains WHERE lower(domain) = lower(?)').get(domain);
  if (existing) {
    throw new Error(`Domain "${domain}" is already registered on this server`);
  }

  const id = crypto.randomUUID();
  const verificationToken = crypto.randomBytes(16).toString('hex');
  const dkimSelector = (opts.dkimSelector || 'cadence').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'cadence';
  const primaryMxHost = (opts.primaryMxHost || (config.smtp.publicHostname !== 'mail.localhost' ? config.smtp.publicHostname : `mail.${domain}`)).toLowerCase();
  const keys = generateDkimKeyPair();
  const encryptedPrivateKey = encryptSecret(keys.privateKeyPem);
  const spfExpected = `v=spf1 mx a:${primaryMxHost} ~all`;
  const dmarcExpected = `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; adkim=r; aspf=r`;
  const now = new Date().toISOString();
  const isInternal = Boolean(opts.activateInternal);

  db.prepare(
    `INSERT INTO domains (
      id, domain, status, ownership_verified, internal_only, verification_token,
      dkim_selector, dkim_public_key, dkim_private_key_enc, primary_mx_host,
      spf_expected, dmarc_expected, last_dns_report_json, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    domain,
    isInternal ? 'active' : 'pending_verification',
    isInternal ? 1 : 0,
    verificationToken,
    dkimSelector,
    keys.publicKeyBase64,
    encryptedPrivateKey,
    primaryMxHost,
    spfExpected,
    dmarcExpected,
    JSON.stringify({ checks: [] }),
    createdByUserId,
    now,
    now
  );

  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(id) as Record<string, any>;
  return formatDomainRow(db, row);
}

export function rotateDomainDkimKey(db: DatabaseSync, domainId: string): HostedDomainRecord {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId) as Record<string, any> | undefined;
  if (!row) throw new Error('Domain not found');
  const keys = generateDkimKeyPair();
  const enc = encryptSecret(keys.privateKeyPem);
  const now = new Date().toISOString();
  db.prepare('UPDATE domains SET dkim_public_key = ?, dkim_private_key_enc = ?, updated_at = ? WHERE id = ?').run(
    keys.publicKeyBase64,
    enc,
    now,
    domainId
  );
  const updated = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId) as Record<string, any>;
  return formatDomainRow(db, updated);
}

export function getDecryptedDkimForAddress(
  db: DatabaseSync,
  fromAddress: string
): { domainName: string; keySelector: string; privateKey: string } | null {
  const domainPart = (fromAddress.split('@')[1] || '').trim().toLowerCase();
  if (!domainPart) return null;
  const row = db
    .prepare(
      "SELECT domain, dkim_selector, dkim_private_key_enc, status FROM domains WHERE lower(domain) = lower(?) AND status != 'disabled' LIMIT 1"
    )
    .get(domainPart) as
    | { domain: string; dkim_selector: string; dkim_private_key_enc: string; status: string }
    | undefined;
  if (!row || !row.dkim_private_key_enc) return null;
  try {
    return {
      domainName: row.domain,
      keySelector: row.dkim_selector,
      privateKey: decryptSecret(row.dkim_private_key_enc),
    };
  } catch {
    return null;
  }
}

async function withDnsTimeout<T>(promise: Promise<T>, label: string, ms = 4500): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`DNS lookup timed out (${ms}ms) for ${label}`)), ms);
    }),
  ]);
}

async function safeTxtLookup(resolver: dns.promises.Resolver, host: string): Promise<{ records: string[]; error?: string }> {
  try {
    const chunks = await withDnsTimeout(resolver.resolveTxt(host), `TXT ${host}`);
    return { records: chunks.map((parts) => parts.join('')) };
  } catch (err: any) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') {
      return { records: [] };
    }
    return { records: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyDomainDns(db: DatabaseSync, domainId: string): Promise<HostedDomainRecord> {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId) as Record<string, any> | undefined;
  if (!row) throw new Error('Domain not found');

  const resolver = new dns.promises.Resolver();
  const checkedAt = new Date().toISOString();
  const domain = String(row.domain);
  const mxHost = String(row.primary_mx_host || `mail.${domain}`).toLowerCase();
  const expectedTokenStr = `cadence-verify=${row.verification_token}`;
  const checks: DnsRecordCheckResult[] = [];

  // 1. Ownership Verification TXT (_cadence-verify.<domain> or apex <domain>)
  const verifySub = await safeTxtLookup(resolver, `_cadence-verify.${domain}`);
  const verifyRoot = await safeTxtLookup(resolver, domain);
  const verifyTxts = [...verifySub.records, ...verifyRoot.records];
  const verifyMatched = verifyTxts.some((val) => val.includes(expectedTokenStr));
  const verifyNetErr = verifySub.error && verifyRoot.error ? verifySub.error : undefined;

  checks.push({
    recordType: 'TXT_VERIFY',
    label: 'Domain Ownership TXT',
    host: `_cadence-verify.${domain}`,
    expectedValue: expectedTokenStr,
    actualValues: verifyTxts,
    status: verifyMatched ? 'verified' : verifyNetErr ? 'dns_unreachable' : verifyTxts.length > 0 ? 'mismatch' : 'missing',
    lastCheckedAt: checkedAt,
    error: verifyNetErr,
    recommendedAction: verifyMatched
      ? 'Ownership confirmed via live DNS.'
      : `Add a TXT record at _cadence-verify.${domain} with value "${expectedTokenStr}".`,
  });

  // 2. MX Record
  let mxActual: string[] = [];
  let mxError: string | undefined;
  let mxMatched = false;
  let mxHostReachable = false;
  try {
    const mxRows = await withDnsTimeout(resolver.resolveMx(domain), `MX ${domain}`);
    mxActual = mxRows.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange.replace(/\.$/, '')}`);
    mxMatched = mxRows.some((m) => m.exchange.replace(/\.$/, '').toLowerCase() === mxHost);
    mxHostReachable = true;
  } catch (err: any) {
    if (err?.code !== 'ENOTFOUND' && err?.code !== 'ENODATA') {
      mxError = err instanceof Error ? err.message : String(err);
    }
  }
  checks.push({
    recordType: 'MX',
    label: 'MX Record',
    host: domain,
    expectedValue: `10 ${mxHost}`,
    actualValues: mxActual,
    status: mxMatched ? 'verified' : mxError ? 'dns_unreachable' : mxActual.length > 0 ? 'mismatch' : 'missing',
    lastCheckedAt: checkedAt,
    error: mxError,
    recommendedAction: mxMatched ? 'MX routing points to configured host.' : `Publish MX record for ${domain} -> 10 ${mxHost}.`,
  });

  // 3. A & AAAA on MX Host
  let ipv4List: string[] = [];
  let aError: string | undefined;
  try {
    ipv4List = await withDnsTimeout(resolver.resolve4(mxHost), `A ${mxHost}`);
  } catch (err: any) {
    if (err?.code !== 'ENOTFOUND' && err?.code !== 'ENODATA') {
      aError = err instanceof Error ? err.message : String(err);
    }
  }
  checks.push({
    recordType: 'A',
    label: 'Mail Host A (IPv4)',
    host: mxHost,
    expectedValue: 'Valid static public IPv4',
    actualValues: ipv4List,
    status: ipv4List.length > 0 ? 'verified' : aError ? 'dns_unreachable' : 'missing',
    lastCheckedAt: checkedAt,
    error: aError,
    recommendedAction: ipv4List.length > 0 ? 'IPv4 A record resolves.' : `Create an A record mapping ${mxHost} to your public server IP.`,
  });

  let ipv6List: string[] = [];
  let aaaaError: string | undefined;
  try {
    ipv6List = await withDnsTimeout(resolver.resolve6(mxHost), `AAAA ${mxHost}`);
  } catch (err: any) {
    if (err?.code !== 'ENOTFOUND' && err?.code !== 'ENODATA') {
      aaaaError = err instanceof Error ? err.message : String(err);
    }
  }
  checks.push({
    recordType: 'AAAA',
    label: 'Mail Host AAAA (IPv6)',
    host: mxHost,
    expectedValue: 'Optional IPv6 address',
    actualValues: ipv6List,
    status: ipv6List.length > 0 ? 'verified' : aaaaError ? 'dns_unreachable' : 'missing',
    lastCheckedAt: checkedAt,
    error: aaaaError,
    recommendedAction: ipv6List.length > 0 ? 'IPv6 AAAA record resolves.' : 'Optional unless sending/receiving over IPv6.',
  });

  // 4. Reverse DNS (PTR)
  let ptrActual: string[] = [];
  let ptrError: string | undefined;
  let ptrMatched = false;
  if (ipv4List.length > 0) {
    try {
      const rev = await withDnsTimeout(resolver.reverse(ipv4List[0]), `PTR ${ipv4List[0]}`);
      ptrActual = rev.map((h) => h.replace(/\.$/, ''));
      ptrMatched = ptrActual.some((h) => h.toLowerCase() === mxHost);
    } catch (err: any) {
      ptrError = err instanceof Error ? err.message : String(err);
    }
  }
  checks.push({
    recordType: 'PTR',
    label: 'Reverse DNS (PTR)',
    host: ipv4List[0] || '<MX IPv4>',
    expectedValue: mxHost,
    actualValues: ptrActual,
    status: ptrMatched ? 'verified' : ptrError || !ipv4List.length ? 'missing' : 'mismatch',
    lastCheckedAt: checkedAt,
    error: ptrError,
    recommendedAction: ptrMatched
      ? 'Reverse DNS matches primary MX hostname.'
      : `Set reverse DNS (PTR) with your hosting provider so ${ipv4List[0] || 'your server IP'} resolves to ${mxHost}.`,
  });

  // 5. SPF TXT
  const spfRecords = verifyRoot.records.filter((r) => r.toLowerCase().startsWith('v=spf1'));
  const spfOk = spfRecords.some((r) => /\b(mx|a:|ip4:|ip6:)/i.test(r));
  checks.push({
    recordType: 'SPF',
    label: 'SPF Record',
    host: domain,
    expectedValue: String(row.spf_expected),
    actualValues: spfRecords,
    status: spfOk ? 'verified' : verifyRoot.error ? 'dns_unreachable' : spfRecords.length > 0 ? 'mismatch' : 'missing',
    lastCheckedAt: checkedAt,
    error: verifyRoot.error,
    recommendedAction: spfOk ? 'SPF TXT policy found.' : `Add TXT record on ${domain}: ${row.spf_expected}`,
  });

  // 6. DKIM TXT
  const dkimHost = `${row.dkim_selector}._domainkey.${domain}`;
  const dkimLookup = await safeTxtLookup(resolver, dkimHost);
  const dkimMatched = dkimLookup.records.some(
    (r) => r.includes('v=DKIM1') && r.replace(/\s+/g, '').includes(`p=${row.dkim_public_key}`)
  );
  checks.push({
    recordType: 'DKIM',
    label: 'DKIM Public Key TXT',
    host: dkimHost,
    expectedValue: `v=DKIM1; k=rsa; p=${row.dkim_public_key}`,
    actualValues: dkimLookup.records,
    status: dkimMatched
      ? 'verified'
      : dkimLookup.error
      ? 'dns_unreachable'
      : dkimLookup.records.length > 0
      ? 'mismatch'
      : 'missing',
    lastCheckedAt: checkedAt,
    error: dkimLookup.error,
    recommendedAction: dkimMatched ? 'Live DKIM public key matches Cadence private key.' : `Publish TXT record at ${dkimHost}.`,
  });

  // 7. DMARC TXT
  const dmarcHost = `_dmarc.${domain}`;
  const dmarcLookup = await safeTxtLookup(resolver, dmarcHost);
  const dmarcOk = dmarcLookup.records.some((r) => /^v=DMARC1\b/i.test(r.trim()));
  checks.push({
    recordType: 'DMARC',
    label: 'DMARC Policy TXT',
    host: dmarcHost,
    expectedValue: String(row.dmarc_expected),
    actualValues: dmarcLookup.records,
    status: dmarcOk
      ? 'verified'
      : dmarcLookup.error
      ? 'dns_unreachable'
      : dmarcLookup.records.length > 0
      ? 'mismatch'
      : 'missing',
    lastCheckedAt: checkedAt,
    error: dmarcLookup.error,
    recommendedAction: dmarcOk ? 'DMARC record is active.' : `Add TXT record at ${dmarcHost}: ${row.dmarc_expected}`,
  });

  // Update DB truthfully — NEVER fabricate ownershipVerified if TXT check failed
  const nextOwnershipVerified = verifyMatched ? 1 : 0;
  const nextStatus = verifyMatched && row.status === 'pending_verification' ? 'active' : row.status;
  const nextInternalOnly = verifyMatched ? 0 : row.internal_only;
  const verifiedAt = verifyMatched ? row.verified_at || checkedAt : row.verified_at;

  db.prepare(
    `UPDATE domains
     SET ownership_verified = ?, internal_only = ?, status = ?, verified_at = ?, last_dns_check_at = ?, last_dns_report_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    nextOwnershipVerified,
    nextInternalOnly,
    nextStatus,
    verifiedAt || null,
    checkedAt,
    JSON.stringify({ checks, mxHostReachable }),
    checkedAt,
    domainId
  );

  const updated = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId) as Record<string, any>;
  return formatDomainRow(db, updated);
}
