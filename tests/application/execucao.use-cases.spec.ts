import { ExecucaoUseCases } from '@application/use-cases/execucao.use-cases';
import { Execucao, ExecucaoStatus as S } from '@domain/entities/execucao.entity';
import { requestContext } from '@shared/logger';
import { InvalidTransitionError, NotFoundError } from '@shared/errors/domain.error';
import { FakeExecucaoRepository } from '../support/fake-repositories';

const servicos = [{ catalogoServicoId: 's-1', pecas: [{ pecaId: 'p-1', quantidade: 2 }] }];

describe('ExecucaoUseCases', () => {
  let repo: FakeExecucaoRepository;
  let uc: ExecucaoUseCases;
  let id: string;

  const criar = async (
    osId = 'os-1',
    prioridade: 'NORMAL' | 'ALTA' = 'NORMAL',
  ): Promise<string> => {
    const e = Execucao.criar({
      ordemServicoId: osId,
      numeroOS: osId,
      clienteId: 'c',
      veiculoId: 'v',
      prioridade,
      sagaId: 'saga-9',
    });
    await repo.commit({ execucao: e });
    return e.id;
  };
  const noContexto = <T>(fn: () => Promise<T>): Promise<T> =>
    requestContext.run({ correlationId: 'corr-api' }, fn);

  beforeEach(async () => {
    repo = new FakeExecucaoRepository();
    uc = new ExecucaoUseCases(repo);
    id = await criar();
  });

  it('fluxo completo do mecânico emite os eventos certos com a saga da execução', async () => {
    await noContexto(async () => {
      await uc.iniciarDiagnostico(id, 'mec-1');
      await uc.concluirDiagnostico(id, 'mec-1', { servicos, observacoes: 'folga' });
    });
    expect(repo.eventos()).toEqual(['DiagnosticoConcluido']);
    expect(repo.outbox[0].envelope).toMatchObject({
      sagaId: 'saga-9',
      correlationId: 'corr-api',
      payload: { ordemServicoId: 'os-1', execucaoId: id, servicos, observacoes: 'folga' },
    });

    // o OS aceita o reparo (IniciarReparo) -> AGUARDANDO_REPARO
    const e = (await repo.findById(id))!;
    e.enfileirarReparo();
    await repo.commit({ execucao: e });

    await uc.iniciarReparo(id, 'mec-1');
    const final = await uc.concluirReparo(id, 'mec-1', 'tudo certo');
    expect(final.status).toBe(S.CONCLUIDA);
    expect(repo.eventos()).toEqual(['DiagnosticoConcluido', 'ReparoConcluido']);

    const { historico } = await uc.obter(id);
    expect(historico.map((h) => h.evento)).toEqual([
      'DIAGNOSTICO_INICIADO',
      'DIAGNOSTICO_CONCLUIDO',
      'REPARO_INICIADO',
      'REPARO_CONCLUIDO',
    ]);
    expect(historico[0]).toMatchObject({
      autor: 'mec-1',
      statusAnterior: S.AGUARDANDO_DIAGNOSTICO,
    });
  });

  it('falha de diagnóstico publica DiagnosticoFalhou', async () => {
    await uc.iniciarDiagnostico(id, 'mec-1');
    const e = await uc.falharDiagnostico(id, 'mec-1', 'carro sumiu');
    expect(e.status).toBe(S.FALHOU);
    expect(repo.outbox[0].envelope).toMatchObject({
      type: 'DiagnosticoFalhou',
      correlationId: 'sem-correlation-id',
      payload: { motivo: 'carro sumiu', execucaoId: id },
    });
  });

  it('falha de reparo publica ReparoFalhou', async () => {
    const e = (await repo.findById(id))!;
    e.iniciarDiagnostico();
    e.concluirDiagnostico(servicos);
    e.enfileirarReparo();
    await repo.commit({ execucao: e });
    await uc.iniciarReparo(id, 'm');
    await uc.falharReparo(id, 'm', 'motor fundido');
    expect(repo.outbox[0].envelope).toMatchObject({
      type: 'ReparoFalhou',
      payload: { motivo: 'motor fundido' },
    });
  });

  it('transição inválida não grava nada', async () => {
    await expect(uc.concluirReparo(id, 'm')).rejects.toThrow(InvalidTransitionError);
    expect(repo.outbox).toHaveLength(0);
    expect((await repo.findById(id))!.status).toBe(S.AGUARDANDO_DIAGNOSTICO);
  });

  it('execução inexistente → NotFoundError', async () => {
    await expect(uc.obter('x')).rejects.toThrow(NotFoundError);
    await expect(uc.iniciarDiagnostico('x', 'm')).rejects.toThrow(NotFoundError);
  });

  it('fila: ALTA antes de NORMAL, depois ordem de chegada; limit é limitado a 1..100', async () => {
    const a = await criar('os-2', 'NORMAL');
    const b = await criar('os-3', 'ALTA');
    const fila = await uc.listarFila(S.AGUARDANDO_DIAGNOSTICO, 1000);
    expect(fila.map((e) => e.id)).toEqual([b, id, a]);
    expect(await uc.listarFila(S.AGUARDANDO_DIAGNOSTICO, 0)).toHaveLength(1);
    expect(await uc.listarFila(S.AGUARDANDO_DIAGNOSTICO)).toHaveLength(3);
  });
});
