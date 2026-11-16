import { IOutboxRepository } from '@domain/repositories/execucao.repository';
import { IMessageBus } from '@domain/services/message-bus';
import { Destinations } from '@shared/messaging/messages';
import { logger } from '@shared/logger';
import { PeriodicTask } from './periodic-task';

export interface OutboxRelayOptions {
  batchSize?: number;
  intervalMs?: number;
  /** Duração do lease: se o pod morrer no meio, outra réplica retoma depois disso. */
  leaseMs?: number;
  /** Teto do backoff exponencial entre tentativas de uma mesma mensagem. */
  maxBackoffMs?: number;
}

/**
 * Publica no SNS `oficina-eventos` os eventos gravados no outbox. O `messageId` é
 * o mesmo em toda tentativa, então o consumidor (inbox do OS) deduplica um reenvio.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly task: PeriodicTask;

  constructor(
    private readonly outbox: IOutboxRepository,
    private readonly bus: IMessageBus,
    options: OutboxRelayOptions = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.task = new PeriodicTask('outbox-relay', options.intervalMs ?? 1000, () => this.tick());
  }

  start(): void {
    this.task.start();
  }

  stop(): Promise<void> {
    return this.task.stop();
  }

  /** Processa um lote; devolve quantas mensagens foram publicadas. */
  async tick(): Promise<number> {
    const batch = await this.outbox.claimBatch(this.batchSize, this.leaseMs);
    let publicadas = 0;
    for (const entry of batch) {
      try {
        await this.bus.publish(Destinations.EventosTopic, entry.envelope);
        await this.outbox.markPublished(entry.id);
        publicadas++;
      } catch (error) {
        const backoff = Math.min(2 ** entry.tentativas * 1000, this.maxBackoffMs);
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          { error: message, outboxId: entry.id, type: entry.envelope.type },
          'Falha ao publicar evento do outbox: nova tentativa agendada',
        );
        await this.outbox.markFailed(entry.id, message, new Date(this.clock().getTime() + backoff));
      }
    }
    return publicadas;
  }
}
