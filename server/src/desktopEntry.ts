import './desktopBootstrap.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { createApp } from './app.js';
import { applyBoundPort, config, DATA_DIR, ROOT_DIR } from './config.js';
import { closeDb, getDb } from './db/database.js';
import { startBackgroundWorker, stopBackgroundWorker } from './services/sendService.js';
import { startPlatformSmtpServices, stopPlatformSmtpServices } from './smtp/smtpServer.js';

function findAppBrowserExecutable(): { exePath: string; name: string } | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    { name: 'Microsoft Edge', exePath: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', exePath: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', exePath: path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Google Chrome', exePath: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', exePath: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', exePath: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
  ];

  for (const item of candidates) {
    if (item.exePath && fs.existsSync(item.exePath)) {
      return item;
    }
  }
  return null;
}

function launchDesktopWindow(url: string): string {
  const browser = findAppBrowserExecutable();
  if (browser) {
    const profileDir = path.join(DATA_DIR, 'window-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    const child = spawn(
      browser.exePath,
      [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        '--window-size=1360,860',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    return `${browser.name} App Window`;
  }

  const fallback = spawn('cmd.exe', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
  });
  fallback.unref();
  return 'Default System Browser';
}

function bindServer(server: http.Server, preferredPort: number, explicitPort: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const onFirstError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !explicitPort && preferredPort !== 0) {
        server.removeListener('listening', onListening);
        server.once('error', reject);
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(err);
    };

    const onListening = () => {
      server.removeListener('error', onFirstError);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to determine bound HTTP port'));
        return;
      }
      resolve(addr.port);
    };

    server.once('error', onFirstError);
    server.once('listening', onListening);
    server.listen(preferredPort, '127.0.0.1');
  });
}

async function main() {
  getDb();
  startBackgroundWorker();
  await startPlatformSmtpServices();

  const app = createApp();
  const server = http.createServer(app);
  const actualPort = await bindServer(server, config.port, process.env.CADENCE_EXPLICIT_PORT === '1');
  applyBoundPort(actualPort);

  const appUrl = `http://127.0.0.1:${actualPort}`;
  let windowMode = 'Headless (--no-browser)';
  if (process.env.CADENCE_NO_BROWSER !== '1') {
    windowMode = launchDesktopWindow(appUrl);
  }

  console.log('==========================================================');
  console.log(' Cadence Mail Desktop');
  console.log('==========================================================');
  console.log(` App URL:        ${appUrl}`);
  console.log(` Display Mode:   ${windowMode}`);
  console.log(` Data Folder:    ${DATA_DIR}`);
  console.log(` Optional .env:  ${path.join(ROOT_DIR, '.env')}`);
  console.log('');
  console.log(' Press Ctrl+C (or type "quit" + Enter) to stop Cadence safely.');
  console.log('==========================================================');

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping Cadence background worker and saving database...');
    stopBackgroundWorker();
    void stopPlatformSmtpServices();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 2000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === 'quit' || cmd === 'exit') {
        rl.close();
        shutdown();
      }
    });
  }
}

main().catch((err) => {
  console.error('[Cadence Desktop] Fatal startup error:', err);
  closeDb();
  process.exit(1);
});
