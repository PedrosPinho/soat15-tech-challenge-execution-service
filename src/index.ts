// Precisa ser o primeiro require do processo — o agente New Relic instrumenta módulos
// (http...) ao serem carregados. Sem NEW_RELIC_LICENSE_KEY, o agente fica desabilitado.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('newrelic');

import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';
import { makeRuntime } from '@main/factories/runtime';
import { Subscription } from '@domain/services/message-bus';
import { Destinations } from '@shared/messaging/messages';
import { logger } from '@shared/logger';

const PORT = process.env.PORT || 3001;
const runtime = makeRuntime();
const app = createApp({
  execucaoController: runtime.controller,
  readiness: { name: 'dynamodb', check: () => runtime.repository.ping().catch(() => false) },
});

let httpServer: ReturnType<typeof app.listen> | undefined;
let subscription: Subscription | undefined;

const startServer = async (): Promise<void> => {
  try {
    httpServer = app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Server running');
    });
    // MESSAGING_ENABLED=false roda só a API (útil para depurar sem filas).
    if (process.env.MESSAGING_ENABLED !== 'false') {
      runtime.relay.start();
      subscription = await runtime.bus.subscribe(Destinations.ExecutionCommands, (envelope) =>
        runtime.commandHandler.handle(envelope),
      );
      logger.info('Consumidor de execution-commands e outbox relay iniciados');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Signal received: closing server');
  httpServer?.close();
  await subscription?.stop();
  await runtime.relay.stop();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void startServer();
