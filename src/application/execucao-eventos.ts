import { Execucao, ExecucaoStatus } from '@domain/entities/execucao.entity';
import { HistoricoEvento } from '@domain/repositories/execucao.repository';
import { createEnvelope, Envelope } from '@shared/messaging/envelope';
import { MessageCatalog } from '@shared/messaging/messages';

export type EventoPublicavel =
  | 'DiagnosticoIniciado'
  | 'DiagnosticoConcluido'
  | 'DiagnosticoFalhou'
  | 'ReparoIniciado'
  | 'ReparoConcluido'
  | 'ReparoFalhou'
  | 'ExecucaoCancelada';

/** Cria o envelope de um evento publicado em `oficina-eventos`. */
export const criarEvento = <T extends EventoPublicavel>(
  type: T,
  sagaId: string,
  correlationId: string,
  payload: MessageCatalog[T],
): Envelope => createEnvelope({ type, sagaId, correlationId, payload });

export const registrarTransicao = (
  evento: string,
  anterior: ExecucaoStatus | undefined,
  execucao: Execucao,
  autor: string,
  detalhes?: Record<string, unknown>,
): HistoricoEvento => ({
  evento,
  statusAnterior: anterior,
  statusNovo: execucao.status,
  detalhes,
  ocorridoEm: execucao.atualizadoEm,
  autor,
});
