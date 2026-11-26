import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeaApi {
  isSea?: () => boolean;
  getAsset?: (key: string, encoding?: BufferEncoding) => string;
  getRawAsset?: (key: string) => ArrayBuffer;
  getAssetKeys?: () => string[];
}

export function getSeaModule(): SeaApi | null {
  try {
    return ((process as any).getBuiltinModule?.('node:sea') as SeaApi | undefined) ?? null;
  } catch {
    return null;
  }
}

export const isSeaApp = Boolean(getSeaModule()?.isSea?.());

const runtimeDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : typeof import.meta !== 'undefined' && import.meta.url
    ? path.dirname(fileURLToPath(import.meta.url))
    : process.cwd();

export const ROOT_DIR = isSeaApp ? path.dirname(process.execPath) : path.resolve(runtimeDir, '..', '..');

const defaultDesktopDataDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'CadenceMail'
);

export const DATA_DIR = path.resolve(
  process.env.CADENCE_DATA_DIR || (isSeaApp ? defaultDesktopDataDir : path.join(ROOT_DIR, 'data'))
);
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
export const QUEUE_DIR = path.join(DATA_DIR, 'queue');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function loadDotEnv(): void {
  loadEnvFile(path.join(ROOT_DIR, '.env'));
  if (DATA_DIR !== ROOT_DIR) {
    loadEnvFile(path.join(DATA_DIR, '.env'));
  }
}

loadDotEnv();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
fs.mkdirSync(QUEUE_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

function resolveMasterKey(): Buffer {
  const envKey = process.env.CADENCE_ENCRYPTION_KEY;
  if (envKey && envKey.length > 0) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    return crypto.createHash('sha256').update(envKey).digest();
  }
  const keyFile = path.join(DATA_DIR, '.cadence-master.key');
  if (fs.existsSync(keyFile)) {
    const hex = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  return Buffer.from(generated, 'hex');
}

export const config = {
  port: Number(process.env.PORT || 4280),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4280}`,
  dbPath: process.env.CADENCE_DB_PATH || path.join(DATA_DIR, 'cadence.db'),
  masterKey: resolveMasterKey(),
  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 4280}/api/v1/accounts/oauth/gmail/callback`,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID || '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
      tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
      redirectUri: process.env.MICROSOFT_REDIRECT_URI || `http://localhost:${process.env.PORT || 4280}/api/v1/accounts/oauth/outlook/callback`,
    },
  },
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
  },
  admin: {
    bootstrapEmail: (process.env.CADENCE_ADMIN_EMAIL || '').trim().toLowerCase(),
  },
  smtp: {
    enabled: process.env.CADENCE_SMTP_ENABLED !== 'false',
    bindHost: process.env.CADENCE_SMTP_BIND || '127.0.0.1',
    mxPort: Number(process.env.CADENCE_SMTP_MX_PORT ?? 2525),
    submissionPort: Number(process.env.CADENCE_SMTP_SUBMISSION_PORT ?? 2587),
    outboundMxPort: Number(process.env.CADENCE_OUTBOUND_MX_PORT ?? 25),
    publicHostname: process.env.CADENCE_PUBLIC_HOSTNAME || 'mail.localhost',
    primaryDomain: (process.env.CADENCE_PRIMARY_DOMAIN || '').trim().toLowerCase(),
    tlsCertPath: process.env.CADENCE_TLS_CERT || '',
    tlsKeyPath: process.env.CADENCE_TLS_KEY || '',
    relayHost: process.env.CADENCE_RELAY_HOST || '',
    relayPort: Number(process.env.CADENCE_RELAY_PORT || 587),
    relaySecure: process.env.CADENCE_RELAY_SECURE === 'true',
    relayUser: process.env.CADENCE_RELAY_USER || '',
    relayPass: process.env.CADENCE_RELAY_PASS || '',
  },
};

export function applyBoundPort(actualPort: number): void {
  config.port = actualPort;
  if (!process.env.CLIENT_ORIGIN) {
    config.clientOrigin = `http://127.0.0.1:${actualPort}`;
  }
  if (!process.env.PUBLIC_URL) {
    config.publicUrl = `http://127.0.0.1:${actualPort}`;
  }
  if (!process.env.GOOGLE_REDIRECT_URI) {
    config.oauth.google.redirectUri = `http://127.0.0.1:${actualPort}/api/v1/accounts/oauth/gmail/callback`;
  }
  if (!process.env.MICROSOFT_REDIRECT_URI) {
    config.oauth.microsoft.redirectUri = `http://127.0.0.1:${actualPort}/api/v1/accounts/oauth/outlook/callback`;
  }
}

export function saveRuntimeEnvSettings(updates: Record<string, string>): void {
  const targetEnvPath = path.join(DATA_DIR, '.env');
  const existingLines = fs.existsSync(targetEnvPath)
    ? fs.readFileSync(targetEnvPath, 'utf8').split(/\r?\n/)
    : [];
  const kv = new Map<string, string>();
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      kv.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    const sanitizedKey = k.replace(/[^A-Z0-9_]/g, '');
    if (!sanitizedKey) continue;
    const val = v.replace(/[\r\n]+/g, ' ').trim();
    if (val) {
      kv.set(sanitizedKey, val);
      process.env[sanitizedKey] = val;
    } else {
      kv.delete(sanitizedKey);
      delete process.env[sanitizedKey];
    }
  }
  const serialized = Array.from(kv.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(targetEnvPath, serialized ? `${serialized}\n` : '', { mode: 0o600 });

  config.oauth.google.clientId = process.env.GOOGLE_CLIENT_ID || '';
  config.oauth.google.clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (process.env.GOOGLE_REDIRECT_URI) {
    config.oauth.google.redirectUri = process.env.GOOGLE_REDIRECT_URI;
  }
  config.oauth.microsoft.clientId = process.env.MICROSOFT_CLIENT_ID || '';
  config.oauth.microsoft.clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';
  config.oauth.microsoft.tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
  if (process.env.MICROSOFT_REDIRECT_URI) {
    config.oauth.microsoft.redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  }
  config.ai.geminiApiKey = process.env.GEMINI_API_KEY || '';
  config.ai.geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  config.ai.openaiApiKey = process.env.OPENAI_API_KEY || '';
  config.ai.openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  config.ai.openaiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  config.ai.anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
  config.ai.anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
}
