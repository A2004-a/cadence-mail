import path from 'node:path';

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log(
      [
        'Cadence Mail Desktop',
        '',
        'Usage:',
        '  Cadence.exe [options]',
        '',
        'Options:',
        '  --port=<number>     Listen on a specific localhost port (default: 4280)',
        '  --data-dir=<path>   Override data directory (default: %LOCALAPPDATA%\\CadenceMail)',
        '  --no-browser        Start backend + UI server without opening the desktop window',
        '  --help, -h          Show this help message',
      ].join('\n')
    );
    process.exit(0);
  } else if (arg === '--no-browser' || arg === '--headless') {
    process.env.CADENCE_NO_BROWSER = '1';
  } else if (arg.startsWith('--port=')) {
    process.env.PORT = arg.slice('--port='.length);
    process.env.CADENCE_EXPLICIT_PORT = '1';
  } else if (arg === '--port' && args[i + 1]) {
    process.env.PORT = args[++i];
    process.env.CADENCE_EXPLICIT_PORT = '1';
  } else if (arg.startsWith('--data-dir=')) {
    process.env.CADENCE_DATA_DIR = path.resolve(arg.slice('--data-dir='.length));
  } else if (arg === '--data-dir' && args[i + 1]) {
    process.env.CADENCE_DATA_DIR = path.resolve(args[++i]);
  }
}
