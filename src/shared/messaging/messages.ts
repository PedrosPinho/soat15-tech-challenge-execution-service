import { Envelope } from './envelope';

/** Destinos lógicos; a URL/ARN real vem da configuração do adapter. */
export const Destinations = {
  ExecutionCommands: 'execution-commands',
  EventosTopic: 'oficina-eventos',
} as const;

// ---- Comandos consumidos (OS -> Execution) ---------------------------------
// Contrato: docs/architecture/contratos-mensagens.md (seção 3.1) no OS Service.

export type Prioridade = 'NORMAL' | 'ALTA';

export interface SolicitarDiagnosticoPayload {
  ordemServicoId: string;
  numeroOS: string;
  clienteId: string;
  veiculoId: string;
  placa?: string;
  descricaoProblema?: string;
  prioridade: Prioridade;
}
export interface IniciarReparoPayload {
  ordemServicoId: string;
  execucaoId: string;
}
export interface CancelarExecucaoPayload {
  ordemServicoId: string;
  execucaoId?: string;
  motivo: string;
}

// ---- Eventos publicados (Execution -> oficina-eventos) ---------------------

export interface DiagnosticoIniciadoPayload {
  ordemServicoId: string;
  execucaoId: string;
}
export interface ServicoDiagnosticado {
  catalogoServicoId: string;
  pecas: { pecaId: string; quantidade: number }[];
}
export interface DiagnosticoConcluidoPayload {
  ordemServicoId: string;
  execucaoId: string;
  servicos: ServicoDiagnosticado[];
  observacoes?: string;
}
export interface MotivoPayload {
  ordemServicoId: string;
  execucaoId?: string;
  motivo: string;
}
export interface ReparoIniciadoPayload {
  ordemServicoId: string;
  execucaoId: string;
}
export interface ReparoConcluidoPayload {
  ordemServicoId: string;
  execucaoId: string;
  observacoes?: string;
}
export interface ExecucaoCanceladaPayload {
  ordemServicoId: string;
  execucaoId?: string;
}

export interface MessageCatalog {
  SolicitarDiagnostico: SolicitarDiagnosticoPayload;
  IniciarReparo: IniciarReparoPayload;
  CancelarExecucao: CancelarExecucaoPayload;
  DiagnosticoIniciado: DiagnosticoIniciadoPayload;
  DiagnosticoConcluido: DiagnosticoConcluidoPayload;
  DiagnosticoFalhou: MotivoPayload;
  ReparoIniciado: ReparoIniciadoPayload;
  ReparoConcluido: ReparoConcluidoPayload;
  ReparoFalhou: MotivoPayload;
  ExecucaoCancelada: ExecucaoCanceladaPayload;
}

export type MessageType = keyof MessageCatalog;
export type TypedEnvelope<T extends MessageType> = Envelope<MessageCatalog[T], T>;

export const COMMAND_TYPES = ['SolicitarDiagnostico', 'IniciarReparo', 'CancelarExecucao'] as const;
