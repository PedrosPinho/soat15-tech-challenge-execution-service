// Precisa ser o primeiro require do processo — o agente New Relic instrumenta módulos
// (http, pg...) ao serem carregados. Sem NEW_RELIC_LICENSE_KEY, o agente fica desabilitado.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('newrelic');

import dotenv from 'dotenv';
import { createApp } from './app';
import { logger } from '@shared/logger';

dotenv.config();

const PORT = process.env.PORT || 3001;
const app = createApp();

let httpServer: ReturnType<typeof app.listen> | undefined;

const startServer = async (): Promise<void> => {
  try {
    httpServer = app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Server running');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Signal received: closing server');
  httpServer?.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void startServer();
