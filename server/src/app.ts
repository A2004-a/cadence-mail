import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, getSeaModule, isSeaApp, ROOT_DIR } from './config.js';
import { accountsRouter } from './routes/accounts.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { automationsRouter } from './routes/automations.js';
import { draftsRouter } from './routes/drafts.js';
import { organizationRouter } from './routes/organization.js';
import { productivityRouter } from './routes/productivity.js';
import { threadsRouter } from './routes/threads.js';
import { workspaceAppsRouter } from './routes/workspaceApps.js';
import { requireAuth, securityHeaders } from './security/authMiddleware.js';
import { eventBus } from './services/eventBus.js';
import { observabilityMiddleware } from './services/observabilityService.js';
import { getSmtpServiceStatus } from './smtp/smtpServer.js';

const STATIC_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function getEmbeddedClientAssets(): Map<string, string> {
  const sea = getSeaModule();
  const map = new Map<string, string>();
  if (!isSeaApp || !sea?.getAssetKeys) return map;
  for (const key of sea.getAssetKeys()) {
    if (key.startsWith('client/')) {
      const routePath = `/${key.slice('client/'.length)}`;
      map.set(routePath, key);
    }
  }
  return map;
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders);

  // Strict CORS for local dev Vite server and localhost desktop window
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (origin === config.clientOrigin ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:'))
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '25mb' }));
  app.use(observabilityMiddleware);

  app.get('/api/v1/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'cadence-mail',
      smtp: getSmtpServiceStatus(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/v1/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    eventBus.subscribe(req.auth!.id, res);
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/automations', automationsRouter);
  app.use('/api/v1/threads', threadsRouter);
  app.use('/api/v1/drafts', draftsRouter);
  app.use('/api/v1/org', organizationRouter);
  app.use('/api/v1/productivity', productivityRouter);
  app.use('/api/v1/workspace', workspaceAppsRouter);

  const embeddedAssets = getEmbeddedClientAssets();
  const sea = getSeaModule();
  if (embeddedAssets.size > 0 && sea?.getRawAsset) {
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      const normalized = req.path === '/' ? '/index.html' : req.path;
      const assetKey = embeddedAssets.get(normalized) || embeddedAssets.get('/index.html');
      if (!assetKey) {
        next();
        return;
      }
      const ext = path.extname(assetKey).toLowerCase();
      res.setHeader('Content-Type', STATIC_MIME_TYPES[ext] || 'application/octet-stream');
      res.setHeader(
        'Cache-Control',
        assetKey.startsWith('client/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      );
      res.send(Buffer.from(sea.getRawAsset!(assetKey)));
    });
  } else {
    const clientDist = path.join(ROOT_DIR, 'client', 'dist');
    if (fs.existsSync(clientDist)) {
      app.use(express.static(clientDist));
      app.get('/{*splat}', (req, res, next) => {
        if (req.path.startsWith('/api/')) {
          next();
          return;
        }
        res.sendFile(path.join(clientDist, 'index.html'));
      });
    }
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Cadence API error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
