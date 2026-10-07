import { readConfig } from './config';
import { createApplication } from './app';
async function main() {
  const config = readConfig();
  const server = await createApplication(config);
  server.http.listen(config.API_PORT, '0.0.0.0', () => console.log(`Chat API listening on port ${config.API_PORT}`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    await server.close();
    clearTimeout(deadline);
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}
void main().catch(error => { console.error('Startup failed', error instanceof Error ? error.message : 'Unknown error'); process.exitCode = 1; });
