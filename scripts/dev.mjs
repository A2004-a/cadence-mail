import { spawn } from 'node:child_process';
import process from 'node:process';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const server = spawn(npmCmd, ['--workspace=server', 'run', 'dev'], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env },
});

const client = spawn(npmCmd, ['--workspace=client', 'run', 'dev'], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env },
});

function shutdown(signal) {
  server.kill(signal);
  client.kill(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('exit', (code) => {
  if (code !== null && code !== 0) {
    client.kill();
    process.exit(code);
  }
});

client.on('exit', (code) => {
  if (code !== null && code !== 0) {
    server.kill();
    process.exit(code);
  }
});
