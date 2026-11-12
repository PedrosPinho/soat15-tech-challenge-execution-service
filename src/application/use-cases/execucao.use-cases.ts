import { Execucao, ExecucaoStatus } from '@domain/entities/execucao.entity';
import { HistoricoEvento, IExecucaoRepository } from '@domain/repositories/execucao.repository';
import { NotFoundError } from '@shared/errors/domain.error';
import { ServicoDiagnosticado } from '@shared/messaging/messages';
import { requestContext } from '@shared/logger';
import { criarEvento, registrarTransicao } from '../execucao-eventos';

export interface ExecucaoDetalhada {
  execucao: Execucao;
  historico: HistoricoEvento[];
}

/** Ações do mecânico (API). Cada ação grava estado + histórico + evento (outbox) atomicamente. */
export class ExecucaoUseCases {
  constructor(private readonly repo: IExecucaoRepository) {}

  listarFila(status: ExecucaoStatus, limit = 20): Promise<Execucao[]> {
    return this.repo.listarFila(status, Math.min(Math.max(limit, 1), 100));
  }

  async obter(id: string): Promise<ExecucaoDetalhada> {
    const execucao = await this.carregar(id);
    return { execucao, historico: await this.repo.historico(id) };
  }

  iniciarDiagnostico(id: string, autor: string): Promise<Execucao> {
    return this.executar(id, autor, 'DIAGNOSTICO_INICIADO', (e) => e.iniciarDiagnostico());
  }

  concluirDiagnostico(
    id: string,
    autor: string,
    input: { servicos: ServicoDiagnosticado[]; observacoes?: string },
  ): Promise<Execucao> {
    return this.executar(
      id,
      autor,
      'DIAGNOSTICO_CONCLUIDO',
      (e) => e.concluirDiagnostico(input.servicos, input.observacoes),
      (e) => [
        criarEvento('DiagnosticoConcluido', e.sagaId, this.correlationId(), {
          ordemServicoId: e.ordemServicoId,
          execucaoId: e.id,
          servicos: input.servicos,
          observacoes: input.observacoes,
        }),
      ],
      { servicos: input.servicos.length },
    );
  }

  falharDiagnostico(id: string, autor: string, motivo: string): Promise<Execucao> {
    return this.executar(
      id,
      autor,
      'DIAGNOSTICO_FALHOU',
      (e) => e.falharDiagnostico(motivo),
      (e) => [
        criarEvento('DiagnosticoFalhou', e.sagaId, this.correlationId(), {
          ordemServicoId: e.ordemServicoId,
          execucaoId: e.id,
          motivo,
        }),
      ],
      { motivo },
    );
  }

  iniciarReparo(id: string, autor: string): Promise<Execucao> {
    return this.executar(id, autor, 'REPARO_INICIADO', (e) => e.iniciarReparo());
  }

  concluirReparo(id: string, autor: string, observacoes?: string): Promise<Execucao> {
    return this.executar(
      id,
      autor,
      'REPARO_CONCLUIDO',
      (e) => e.concluirReparo(observacoes),
      (e) => [
        criarEvento('ReparoConcluido', e.sagaId, this.correlationId(), {
          ordemServicoId: e.ordemServicoId,
          execucaoId: e.id,
          observacoes,
        }),
      ],
    );
  }

  falharReparo(id: string, autor: string, motivo: string): Promise<Execucao> {
    return this.executar(
      id,
      autor,
      'REPARO_FALHOU',
      (e) => e.falharReparo(motivo),
      (e) => [
        criarEvento('ReparoFalhou', e.sagaId, this.correlationId(), {
          ordemServicoId: e.ordemServicoId,
          execucaoId: e.id,
          motivo,
        }),
      ],
      { motivo },
    );
  }

  private async executar(
    id: string,
    autor: string,
    evento: string,
    mutar: (e: Execucao) => void,
    mensagens: (e: Execucao) => ReturnType<typeof criarEvento>[] = () => [],
    detalhes?: Record<string, unknown>,
  ): Promise<Execucao> {
    const execucao = await this.carregar(id);
    const anterior = execucao.status;
    mutar(execucao);
    await this.repo.commit({
      execucao,
      historico: [registrarTransicao(evento, anterior, execucao, autor, detalhes)],
      mensagens: mensagens(execucao),
    });
    return execucao;
  }

  private async carregar(id: string): Promise<Execucao> {
    const execucao = await this.repo.findById(id);
    if (!execucao) throw new NotFoundError(`Execução ${id} não encontrada`);
    return execucao;
  }

  private correlationId(): string {
    return requestContext.getStore()?.correlationId ?? 'sem-correlation-id';
  }
}
