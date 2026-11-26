import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const useExe = process.argv.includes('--exe');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-e2e-'));
const port = process.env.E2E_PORT || (useExe ? '4291' : '4289');
const baseUrl = `http://127.0.0.1:${port}`;
const pythonBin = process.platform === 'win32' ? 'C:\\Python314\\python.exe' : 'python3';

const serverEnv = {
  ...process.env,
  PORT: port,
  NODE_ENV: 'production',
  CLIENT_ORIGIN: baseUrl,
  PUBLIC_URL: baseUrl,
  CADENCE_DATA_DIR: tempDir,
  CADENCE_DB_PATH: path.join(tempDir, 'e2e.db'),
};

function resolveTargetExe() {
  if (process.env.CADENCE_EXE_PATH) return process.env.CADENCE_EXE_PATH;
  const primary = path.join(process.cwd(), 'dist-exe', 'Cadence.exe');
  const updated = path.join(process.cwd(), 'dist-exe', 'Cadence-updated.exe');
  if (fs.existsSync(updated)) {
    if (!fs.existsSync(primary) || fs.statSync(updated).mtimeMs >= fs.statSync(primary).mtimeMs) {
      return updated;
    }
  }
  return primary;
}

const server = useExe
  ? spawn(resolveTargetExe(), ['--no-browser', `--port=${port}`, `--data-dir=${tempDir}`], {
      cwd: tempDir,
      stdio: 'inherit',
      env: serverEnv,
    })
  : spawn(process.execPath, ['server/dist/index.js'], {
      stdio: 'inherit',
      env: serverEnv,
    });

async function waitForHealth() {
  let lastErr = '';
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become healthy in time (${lastErr})`);
}

try {
  await waitForHealth();
  const exitCode = await new Promise((resolve) => {
    const py = spawn(pythonBin, ['tests/e2e_playwright.py'], {
      stdio: 'inherit',
      env: { ...process.env, CADENCE_E2E_URL: baseUrl },
    });
    py.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((r) => {
    const t = setTimeout(r, 2000);
    server.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore Windows handle cleanup race
  }
}
