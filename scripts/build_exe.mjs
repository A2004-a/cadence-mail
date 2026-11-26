import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const outDir = path.join(rootDir, 'dist-exe');
const stageDir = path.join(outDir, '_stage');
const clientDistDir = path.join(rootDir, 'client', 'dist');
const serverEntry = path.join(rootDir, 'server', 'src', 'desktopEntry.ts');
const bundlePath = path.join(stageDir, 'cadence-server.cjs');
const seaConfigPath = path.join(stageDir, 'sea-config.json');
const exePath = path.join(outDir, 'Cadence.exe');

function runChecked(cmd, args, label) {
  console.log(`[build:exe] ${label}...`);
  const res = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
  });
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status ?? 1}`);
  }
}

function collectFiles(dirPath, basePrefix, assetsMap) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    const key = `${basePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectFiles(full, key, assetsMap);
    } else if (entry.isFile()) {
      assetsMap[key] = full;
    }
  }
}

function main() {
  if (!process.argv.includes('--skip-client-build')) {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    runChecked(npmBin, ['--workspace=client', 'run', 'build'], 'Building Cadence client bundle');
  }

  if (!fs.existsSync(path.join(clientDistDir, 'index.html'))) {
    throw new Error(`Missing built frontend at ${clientDistDir}. Run "npm run build" first.`);
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const esbuildEntry = path.join(rootDir, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (!fs.existsSync(esbuildEntry)) {
    throw new Error(`esbuild package entry not found at ${esbuildEntry}`);
  }

  runChecked(
    process.execPath,
    [
      esbuildEntry,
      serverEntry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node24',
      '--define:import.meta.url=undefined',
      `--outfile=${bundlePath}`,
      '--log-level=warning',
    ],
    'Bundling Cadence desktop server'
  );

  const assets = {};
  collectFiles(clientDistDir, 'client', assets);
  const assetCount = Object.keys(assets).length;
  console.log(`[build:exe] Embedding ${assetCount} client asset(s) inside executable...`);

  const stagedExePath = path.join(stageDir, 'Cadence.exe');
  const updatedExePath = path.join(outDir, 'Cadence-updated.exe');

  const seaConfig = {
    main: bundlePath,
    output: stagedExePath,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets,
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  runChecked(process.execPath, ['--build-sea', seaConfigPath], 'Building single executable Cadence.exe');

  let finalExePath = exePath;
  try {
    if (fs.existsSync(exePath)) {
      fs.unlinkSync(exePath);
    }
    fs.renameSync(stagedExePath, exePath);
    if (fs.existsSync(updatedExePath)) {
      try {
        fs.unlinkSync(updatedExePath);
      } catch {
        // ignore stale cleanup
      }
    }
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      fs.copyFileSync(stagedExePath, updatedExePath);
      finalExePath = updatedExePath;
      console.warn(
        `[build:exe] WARNING: Existing ${exePath} is currently running/locked.\n` +
          `[build:exe] Wrote updated executable to ${updatedExePath} instead. Close the running Cadence window and rename Cadence-updated.exe -> Cadence.exe (or run Cadence-updated.exe directly).`
      );
    } else {
      throw err;
    }
  }

  // Copy portable .env.example & user quickstart beside Cadence.exe
  const envExampleSrc = path.join(rootDir, '.env.example');
  if (fs.existsSync(envExampleSrc)) {
    fs.copyFileSync(envExampleSrc, path.join(outDir, '.env.example'));
  }

  fs.writeFileSync(
    path.join(outDir, 'README.txt'),
    [
      'Cadence Mail Desktop (.exe)',
      '===========================',
      '',
      '1. Double-click Cadence.exe to launch the Cadence Mail desktop app window.',
      '2. Persistent SQLite database, encrypted credentials, and attachments are stored in:',
      '   %LOCALAPPDATA%\\CadenceMail',
      '3. Optional configuration:',
      '   Copy .env.example to .env in the same folder as Cadence.exe (or inside %LOCALAPPDATA%\\CadenceMail)',
      '   to add Gmail/Microsoft OAuth keys or Gemini/OpenAI/Anthropic API keys.',
      '4. Optional CLI flags:',
      '   Cadence.exe --port=4280          Use a specific port',
      '   Cadence.exe --data-dir=PATH      Use a custom/portable data folder',
      '   Cadence.exe --no-browser         Run headless without auto-opening a window',
      '',
    ].join('\r\n'),
    'utf8'
  );

  // Clean up temporary staging files
  fs.rmSync(stageDir, { recursive: true, force: true });

  const stats = fs.statSync(finalExePath);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`[build:exe] SUCCESS: ${finalExePath} (${sizeMb} MB)`);
}

main();
