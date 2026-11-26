import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, getDb } from './db/database.js';
import { startBackgroundWorker, stopBackgroundWorker } from './services/sendService.js';
import { startPlatformSmtpServices, stopPlatformSmtpServices } from './smtp/smtpServer.js';

getDb();
startBackgroundWorker();
void startPlatformSmtpServices();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Cadence backend listening on http://localhost:${config.port}`);
});

function shutdown() {
  stopBackgroundWorker();
  void stopPlatformSmtpServices().finally(() => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
