import { Execucao, ExecucaoStatus } from '@domain/entities/execucao.entity';
import { IExecucaoRepository } from '@domain/repositories/execucao.repository';
import {
  DuplicateMessageError,
  InvalidMessageError,
  ValidationError,
} from '@shared/errors/domain.error';
import { Envelope } from '@shared/messaging/envelope';
import {
  CancelarExecucaoPayload,
  IniciarReparoPayload,
  SolicitarDiagnosticoPayload,
} from '@shared/messaging/messages';
import { logger } from '@shared/logger';
import { criarEvento, registrarTransicao } from '../execucao-eventos';

const SISTEMA = 'sistema';
const VERSAO_SUPORTADA = 1;

/**
 * Consumidor da fila `execution-commands`. Regras do contrato:
 * - todo comando gera exatamente um evento de resposta (sucesso ou falha);
 * - idempotente: o `messageId` vai para o inbox na MESMA transação do efeito, e
 *   comandos repetidos com `messageId` novo (reenvio do orquestrador) reproduzem
 *   a resposta sem duplicar a execução;
 * - tipo/versão/payload inválidos são erro permanente (lança → reentrega → DLQ).
 */
export class ExecutionCommandHandler {
  constructor(private readonly repo: IExecucaoRepository) {}

  async handle(envelope: Envelope): Promise<void> {
    if (envelope.version !== VERSAO_SUPORTADA) {
      throw new InvalidMessageError(
        `Versão ${envelope.version} de ${envelope.type} não suportada (messageId ${envelope.messageId})`,
      );
    }
    try {
      switch (envelope.type) {
        case 'SolicitarDiagnostico':
          return await this.solicitarDiagnostico(
            envelope,
            envelope.payload as SolicitarDiagnosticoPayload,
          );
        case 'IniciarReparo':
          return await this.iniciarReparo(envelope, envelope.payload as IniciarReparoPayload);
        case 'CancelarExecucao':
          return await this.cancelarExecucao(envelope, envelope.payload as CancelarExecucaoPayload);
        default:
          throw new InvalidMessageError(`Comando desconhecido: ${envelope.type}`);
      }
    } catch (error) {
      if (error instanceof DuplicateMessageError) {
        logger.info(
          { messageId: envelope.messageId, type: envelope.type },
          'Mensagem já processada: confirmando sem reprocessar',
        );
        return;
      }
      throw error;
    }
  }

  private requerOsId(envelope: Envelope): string {
    const osId = (envelope.payload as { ordemServicoId?: unknown }).ordemServicoId;
    if (typeof osId !== 'string' || !osId) {
      throw new InvalidMessageError(
        `${envelope.type} sem ordemServicoId (messageId ${envelope.messageId})`,
      );
    }
    return osId;
  }

  private resposta = <T extends Parameters<typeof criarEvento>[0]>(
    envelope: Envelope,
    type: T,
    payload: Parameters<typeof criarEvento<T>>[3],
  ): Envelope => criarEvento(type, envelope.sagaId, envelope.correlationId, payload);

  private async solicitarDiagnostico(env: Envelope, p: SolicitarDiagnosticoPayload): Promise<void> {
    const osId = this.requerOsId(env);

    const existente = await this.repo.findByOrdemServicoId(osId);
    if (existente) {
      const cancelada = existente.status === ExecucaoStatus.CANCELADA;
      await this.repo.commit({
        inboxMessageId: env.messageId,
        mensagens: [
          cancelada
            ? this.resposta(env, 'DiagnosticoFalhou', {
                ordemServicoId: osId,
                execucaoId: existente.id,
                motivo: 'Execução já cancelada',
              })
            : this.resposta(env, 'DiagnosticoIniciado', {
                ordemServicoId: osId,
                execucaoId: existente.id,
              }),
        ],
      });
      return;
    }

    let execucao: Execucao;
    try {
      execucao = Execucao.criar({ ...p, sagaId: env.sagaId });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await this.repo.commit({
        inboxMessageId: env.messageId,
        mensagens: [
          this.resposta(env, 'DiagnosticoFalhou', { ordemServicoId: osId, motivo: error.message }),
        ],
      });
      return;
    }

    await this.repo.commit({
      execucao,
      inboxMessageId: env.messageId,
      historico: [
        registrarTransicao('EXECUCAO_CRIADA', undefined, execucao, SISTEMA, {
          numeroOS: p.numeroOS,
          prioridade: execucao.prioridade,
        }),
      ],
      mensagens: [
        this.resposta(env, 'DiagnosticoIniciado', {
          ordemServicoId: osId,
          execucaoId: execucao.id,
        }),
      ],
    });
  }

  private async iniciarReparo(env: Envelope, p: IniciarReparoPayload): Promise<void> {
    const osId = this.requerOsId(env);
    const execucao = p.execucaoId ? await this.repo.findById(p.execucaoId) : null;

    const falha = (motivo: string): Envelope =>
      this.resposta(env, 'ReparoFalhou', {
        ordemServicoId: osId,
        execucaoId: p.execucaoId,
        motivo,
      });

    if (!execucao || execucao.ordemServicoId !== osId) {
      await this.repo.commit({
        inboxMessageId: env.messageId,
        mensagens: [falha('Execução não encontrada')],
      });
      return;
    }

    const confirmacao = this.resposta(env, 'ReparoIniciado', {
      ordemServicoId: osId,
      execucaoId: execucao.id,
    });

    switch (execucao.status) {
      case ExecucaoStatus.DIAGNOSTICADA: {
        const anterior = execucao.status;
        execucao.enfileirarReparo();
        await this.repo.commit({
          execucao,
          inboxMessageId: env.messageId,
          historico: [registrarTransicao('REPARO_ENFILEIRADO', anterior, execucao, SISTEMA)],
          mensagens: [confirmacao],
        });
        return;
      }
      case ExecucaoStatus.AGUARDANDO_REPARO:
      case ExecucaoStatus.EM_REPARO:
      case ExecucaoStatus.CONCLUIDA:
        // Reenvio do orquestrador: o reparo já foi aceito — repete a confirmação.
        await this.repo.commit({ inboxMessageId: env.messageId, mensagens: [confirmacao] });
        return;
      default:
        await this.repo.commit({
          inboxMessageId: env.messageId,
          mensagens: [falha(`Reparo não pode iniciar com a execução em ${execucao.status}`)],
        });
    }
  }

  private async cancelarExecucao(env: Envelope, p: CancelarExecucaoPayload): Promise<void> {
    const osId = this.requerOsId(env);
    const execucao = p.execucaoId
      ? await this.repo.findById(p.execucaoId)
      : await this.repo.findByOrdemServicoId(osId);

    const cancelada = (id?: string): Envelope =>
      this.resposta(env, 'ExecucaoCancelada', { ordemServicoId: osId, execucaoId: id });

    // Inexistente ou já terminal: compensação é no-op idempotente, mas responde sempre.
    if (!execucao || execucao.ordemServicoId !== osId || execucao.terminal) {
      await this.repo.commit({
        inboxMessageId: env.messageId,
        mensagens: [cancelada(execucao?.id ?? p.execucaoId)],
      });
      return;
    }

    const anterior = execucao.status;
    execucao.cancelar(p.motivo ?? 'Cancelada pela Saga');
    await this.repo.commit({
      execucao,
      inboxMessageId: env.messageId,
      historico: [
        registrarTransicao('EXECUCAO_CANCELADA', anterior, execucao, SISTEMA, { motivo: p.motivo }),
      ],
      mensagens: [cancelada(execucao.id)],
    });
  }
}
