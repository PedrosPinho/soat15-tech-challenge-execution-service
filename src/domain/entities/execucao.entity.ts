import { randomUUID } from 'node:crypto';
import { InvalidTransitionError, ValidationError } from '@shared/errors/domain.error';
import { Prioridade, ServicoDiagnosticado } from '@shared/messaging/messages';

export enum ExecucaoStatus {
  AGUARDANDO_DIAGNOSTICO = 'AGUARDANDO_DIAGNOSTICO',
  EM_DIAGNOSTICO = 'EM_DIAGNOSTICO',
  DIAGNOSTICADA = 'DIAGNOSTICADA',
  AGUARDANDO_REPARO = 'AGUARDANDO_REPARO',
  EM_REPARO = 'EM_REPARO',
  CONCLUIDA = 'CONCLUIDA',
  FALHOU = 'FALHOU',
  CANCELADA = 'CANCELADA',
}

const TERMINAIS: ReadonlySet<ExecucaoStatus> = new Set([
  ExecucaoStatus.CONCLUIDA,
  ExecucaoStatus.FALHOU,
  ExecucaoStatus.CANCELADA,
]);

export interface Diagnostico {
  servicos: ServicoDiagnosticado[];
  observacoes?: string;
}

export interface ExecucaoProps {
  id: string;
  ordemServicoId: string;
  numeroOS: string;
  clienteId: string;
  veiculoId: string;
  placa?: string;
  descricaoProblema?: string;
  prioridade: Prioridade;
  status: ExecucaoStatus;
  /** Saga do OS que originou a execução — vai em todo evento publicado. */
  sagaId: string;
  diagnostico?: Diagnostico;
  observacoesReparo?: string;
  motivo?: string;
  /** Lock otimista: versão lida do banco (0 = ainda não persistida). */
  versao: number;
  criadoEm: Date;
  atualizadoEm: Date;
}

export interface NovaExecucaoInput {
  ordemServicoId: string;
  numeroOS: string;
  clienteId: string;
  veiculoId: string;
  placa?: string;
  descricaoProblema?: string;
  prioridade: Prioridade;
  sagaId: string;
}

/**
 * Agregado da fila de execução. Ciclo:
 *
 * AGUARDANDO_DIAGNOSTICO → EM_DIAGNOSTICO → DIAGNOSTICADA → AGUARDANDO_REPARO
 *   → EM_REPARO → CONCLUIDA | FALHOU;  CANCELADA a partir de qualquer estado não terminal.
 * Falha de diagnóstico leva a FALHOU.
 *
 * Os métodos mutam o agregado e validam a transição; quem persiste (repositório)
 * grava junto o histórico e as mensagens do outbox.
 */
export class Execucao {
  private constructor(private props: ExecucaoProps) {}

  static criar(input: NovaExecucaoInput, agora: Date = new Date()): Execucao {
    for (const campo of [
      'ordemServicoId',
      'numeroOS',
      'clienteId',
      'veiculoId',
      'sagaId',
    ] as const) {
      if (!input[campo]) throw new ValidationError(`Campo obrigatório ausente: ${campo}`);
    }
    return new Execucao({
      ...input,
      id: randomUUID(),
      prioridade: input.prioridade === 'ALTA' ? 'ALTA' : 'NORMAL',
      status: ExecucaoStatus.AGUARDANDO_DIAGNOSTICO,
      versao: 0,
      criadoEm: agora,
      atualizadoEm: agora,
    });
  }

  static restaurar(props: ExecucaoProps): Execucao {
    return new Execucao({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get ordemServicoId(): string {
    return this.props.ordemServicoId;
  }
  get numeroOS(): string {
    return this.props.numeroOS;
  }
  get clienteId(): string {
    return this.props.clienteId;
  }
  get veiculoId(): string {
    return this.props.veiculoId;
  }
  get placa(): string | undefined {
    return this.props.placa;
  }
  get descricaoProblema(): string | undefined {
    return this.props.descricaoProblema;
  }
  get prioridade(): Prioridade {
    return this.props.prioridade;
  }
  get status(): ExecucaoStatus {
    return this.props.status;
  }
  get sagaId(): string {
    return this.props.sagaId;
  }
  get diagnostico(): Diagnostico | undefined {
    return this.props.diagnostico;
  }
  get observacoesReparo(): string | undefined {
    return this.props.observacoesReparo;
  }
  get motivo(): string | undefined {
    return this.props.motivo;
  }
  get versao(): number {
    return this.props.versao;
  }
  get criadoEm(): Date {
    return this.props.criadoEm;
  }
  get atualizadoEm(): Date {
    return this.props.atualizadoEm;
  }

  get terminal(): boolean {
    return TERMINAIS.has(this.props.status);
  }

  toProps(): ExecucaoProps {
    return { ...this.props };
  }

  iniciarDiagnostico(agora: Date = new Date()): void {
    this.transitar([ExecucaoStatus.AGUARDANDO_DIAGNOSTICO], ExecucaoStatus.EM_DIAGNOSTICO, agora);
  }

  concluirDiagnostico(
    servicos: ServicoDiagnosticado[],
    observacoes?: string,
    agora: Date = new Date(),
  ): void {
    Execucao.validarServicos(servicos);
    this.transitar([ExecucaoStatus.EM_DIAGNOSTICO], ExecucaoStatus.DIAGNOSTICADA, agora);
    this.props.diagnostico = { servicos, observacoes };
  }

  falharDiagnostico(motivo: string, agora: Date = new Date()): void {
    this.transitar([ExecucaoStatus.EM_DIAGNOSTICO], ExecucaoStatus.FALHOU, agora);
    this.props.motivo = motivo;
  }

  /** Comando `IniciarReparo` do OS: o reparo entra na fila de reparos. */
  enfileirarReparo(agora: Date = new Date()): void {
    this.transitar([ExecucaoStatus.DIAGNOSTICADA], ExecucaoStatus.AGUARDANDO_REPARO, agora);
  }

  iniciarReparo(agora: Date = new Date()): void {
    this.transitar([ExecucaoStatus.AGUARDANDO_REPARO], ExecucaoStatus.EM_REPARO, agora);
  }

  concluirReparo(observacoes?: string, agora: Date = new Date()): void {
    this.transitar([ExecucaoStatus.EM_REPARO], ExecucaoStatus.CONCLUIDA, agora);
    this.props.observacoesReparo = observacoes;
  }

  falharReparo(motivo: string, agora: Date = new Date()): void {
    this.transitar([ExecucaoStatus.EM_REPARO], ExecucaoStatus.FALHOU, agora);
    this.props.motivo = motivo;
  }

  cancelar(motivo: string, agora: Date = new Date()): void {
    this.transitar(
      [
        ExecucaoStatus.AGUARDANDO_DIAGNOSTICO,
        ExecucaoStatus.EM_DIAGNOSTICO,
        ExecucaoStatus.DIAGNOSTICADA,
        ExecucaoStatus.AGUARDANDO_REPARO,
        ExecucaoStatus.EM_REPARO,
      ],
      ExecucaoStatus.CANCELADA,
      agora,
    );
    this.props.motivo = motivo;
  }

  /** Chamado pelo repositório após gravar com sucesso. */
  registrarPersistencia(): void {
    this.props.versao += 1;
  }

  private transitar(origens: ExecucaoStatus[], destino: ExecucaoStatus, agora: Date): void {
    if (!origens.includes(this.props.status)) {
      throw new InvalidTransitionError(
        `Transição inválida: ${this.props.status} → ${destino} (execução ${this.props.id})`,
      );
    }
    this.props.status = destino;
    this.props.atualizadoEm = agora;
  }

  private static validarServicos(servicos: ServicoDiagnosticado[]): void {
    if (!Array.isArray(servicos) || servicos.length === 0) {
      throw new ValidationError('O diagnóstico deve informar ao menos um serviço');
    }
    for (const s of servicos) {
      if (!s.catalogoServicoId) throw new ValidationError('catalogoServicoId é obrigatório');
      for (const p of s.pecas ?? []) {
        if (!p.pecaId || !Number.isInteger(p.quantidade) || p.quantidade < 1) {
          throw new ValidationError('Peça inválida: informe pecaId e quantidade inteira >= 1');
        }
      }
    }
  }
}
