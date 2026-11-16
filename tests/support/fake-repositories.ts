import { Execucao, ExecucaoStatus } from '@domain/entities/execucao.entity';
import {
  CommitInput,
  HistoricoEvento,
  IExecucaoRepository,
  IOutboxRepository,
  OutboxEntry,
} from '@domain/repositories/execucao.repository';
import { ConcurrencyError, DuplicateMessageError } from '@shared/errors/domain.error';
import { Envelope } from '@shared/messaging/envelope';

/**
 * Repositório em memória com a MESMA semântica transacional do DynamoDB:
 * lock otimista por versão, inbox atômico e uma execução por OS.
 */
export class FakeExecucaoRepository implements IExecucaoRepository, IOutboxRepository {
  readonly execucoes = new Map<string, ReturnType<Execucao['toProps']>>();
  readonly historicos = new Map<string, HistoricoEvento[]>();
  readonly inbox = new Set<string>();
  readonly outbox: { id: string; envelope: Envelope; publicada: boolean; tentativas: number }[] =
    [];
  commits = 0;

  async findById(id: string): Promise<Execucao | null> {
    const p = this.execucoes.get(id);
    return p ? Execucao.restaurar({ ...p }) : null;
  }
  async findByOrdemServicoId(osId: string): Promise<Execucao | null> {
    const p = [...this.execucoes.values()].find((e) => e.ordemServicoId === osId);
    return p ? Execucao.restaurar({ ...p }) : null;
  }
  async listarFila(status: ExecucaoStatus, limit: number): Promise<Execucao[]> {
    return [...this.execucoes.values()]
      .filter((e) => e.status === status)
      .sort((a, b) =>
        a.prioridade === b.prioridade
          ? a.criadoEm.getTime() - b.criadoEm.getTime()
          : a.prioridade === 'ALTA'
            ? -1
            : 1,
      )
      .slice(0, limit)
      .map((p) => Execucao.restaurar({ ...p }));
  }
  async historico(id: string): Promise<HistoricoEvento[]> {
    return this.historicos.get(id) ?? [];
  }

  async commit(input: CommitInput): Promise<void> {
    if (input.inboxMessageId && this.inbox.has(input.inboxMessageId)) {
      throw new DuplicateMessageError(input.inboxMessageId);
    }
    const { execucao } = input;
    if (execucao) {
      const atual = this.execucoes.get(execucao.id);
      if (atual ? atual.versao !== execucao.versao : execucao.versao !== 0) {
        throw new ConcurrencyError('versão divergente');
      }
      if (
        !atual &&
        [...this.execucoes.values()].some((e) => e.ordemServicoId === execucao.ordemServicoId)
      ) {
        throw new ConcurrencyError('OS já possui execução');
      }
    }
    // tudo validado: aplica (atomicidade)
    this.commits++;
    if (input.inboxMessageId) this.inbox.add(input.inboxMessageId);
    if (execucao) {
      execucao.registrarPersistencia();
      this.execucoes.set(execucao.id, execucao.toProps());
      this.historicos.set(execucao.id, [
        ...(this.historicos.get(execucao.id) ?? []),
        ...(input.historico ?? []),
      ]);
    }
    for (const m of input.mensagens ?? []) {
      this.outbox.push({ id: m.messageId, envelope: m, publicada: false, tentativas: 0 });
    }
  }

  // ---- outbox ----
  falhasPublicacao = new Set<string>();
  async claimBatch(limit: number): Promise<OutboxEntry[]> {
    return this.outbox
      .filter((o) => !o.publicada)
      .slice(0, limit)
      .map((o) => ({ id: o.id, envelope: o.envelope, tentativas: o.tentativas }));
  }
  async markPublished(id: string): Promise<void> {
    this.outbox.find((o) => o.id === id)!.publicada = true;
  }
  async markFailed(id: string): Promise<void> {
    this.outbox.find((o) => o.id === id)!.tentativas++;
  }

  eventos(): string[] {
    return this.outbox.map((o) => o.envelope.type);
  }
}
