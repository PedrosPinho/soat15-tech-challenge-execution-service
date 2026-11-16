import { Execucao, ExecucaoStatus } from '@domain/entities/execucao.entity';
import { Envelope } from '@shared/messaging/envelope';

export interface HistoricoEvento {
  /** Nome do fato (ex.: `DIAGNOSTICO_INICIADO`). */
  evento: string;
  statusAnterior?: ExecucaoStatus;
  statusNovo?: ExecucaoStatus;
  detalhes?: Record<string, unknown>;
  ocorridoEm: Date;
  /** `userId` do mecânico (API) ou `sistema` (comando do OS). */
  autor: string;
}

export interface OutboxEntry {
  /** `messageId` do envelope: estável entre tentativas de reenvio. */
  id: string;
  envelope: Envelope;
  tentativas: number;
}

export interface CommitInput {
  /** Agregado alterado/criado. Ausente quando só há resposta (ex.: cancelar execução inexistente). */
  execucao?: Execucao;
  historico?: HistoricoEvento[];
  /** Eventos a publicar — gravados atomicamente com a mudança de estado. */
  mensagens?: Envelope[];
  /** `messageId` do comando consumido: grava o inbox na mesma transação. */
  inboxMessageId?: string;
}

export interface IExecucaoRepository {
  findById(id: string): Promise<Execucao | null>;
  findByOrdemServicoId(ordemServicoId: string): Promise<Execucao | null>;
  /** Fila ordenada por prioridade (ALTA primeiro) e ordem de chegada. */
  listarFila(status: ExecucaoStatus, limit: number): Promise<Execucao[]>;
  historico(execucaoId: string): Promise<HistoricoEvento[]>;
  /**
   * Grava tudo de forma atômica (`TransactWriteItems`): estado + histórico + outbox + inbox.
   * @throws ConcurrencyError se a versão do agregado mudou desde a leitura
   * @throws DuplicateMessageError se o `inboxMessageId` já foi processado
   */
  commit(input: CommitInput): Promise<void>;
}

export interface IOutboxRepository {
  /** Reivindica (lease) até `limit` mensagens pendentes e prontas para envio. */
  claimBatch(limit: number, leaseMs: number): Promise<OutboxEntry[]>;
  markPublished(id: string): Promise<void>;
  markFailed(id: string, erro: string, proximaTentativaEm: Date): Promise<void>;
}
