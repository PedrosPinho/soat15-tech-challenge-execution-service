import { ExecutionCommandHandler } from '@application/messaging/execution-command-handler';
import { Execucao, ExecucaoStatus as S } from '@domain/entities/execucao.entity';
import { InvalidMessageError } from '@shared/errors/domain.error';
import { createEnvelope, Envelope } from '@shared/messaging/envelope';
import { FakeExecucaoRepository } from '../../support/fake-repositories';

const SAGA = 'saga-1';
const CORR = 'corr-1';

type Extra = { version?: number; messageId?: string };

const cmd = (type: string, payload: object, extra: Extra = {}): Envelope =>
  createEnvelope({ type, sagaId: SAGA, correlationId: CORR, payload, ...extra });

const solicitar = (over: object = {}, extra: Extra = {}): Envelope =>
  cmd(
    'SolicitarDiagnostico',
    {
      ordemServicoId: 'os-1',
      numeroOS: 'OS-1',
      clienteId: 'c-1',
      veiculoId: 'v-1',
      placa: 'ABC1D23',
      prioridade: 'ALTA',
      ...over,
    },
    extra,
  );

describe('ExecutionCommandHandler', () => {
  let repo: FakeExecucaoRepository;
  let handler: ExecutionCommandHandler;

  beforeEach(() => {
    repo = new FakeExecucaoRepository();
    handler = new ExecutionCommandHandler(repo);
  });

  const execucaoDeOs = async (osId = 'os-1'): Promise<Execucao> =>
    (await repo.findByOrdemServicoId(osId))!;
  const ultimo = (): Envelope => repo.outbox[repo.outbox.length - 1].envelope;

  describe('SolicitarDiagnostico', () => {
    it('cria a execução, enfileira e responde DiagnosticoIniciado com saga e correlation do comando', async () => {
      await handler.handle(solicitar());

      const e = await execucaoDeOs();
      expect(e.status).toBe(S.AGUARDANDO_DIAGNOSTICO);
      expect(e.prioridade).toBe('ALTA');
      expect(e.sagaId).toBe(SAGA);
      expect(repo.eventos()).toEqual(['DiagnosticoIniciado']);
      expect(ultimo()).toMatchObject({
        sagaId: SAGA,
        correlationId: CORR,
        payload: { ordemServicoId: 'os-1', execucaoId: e.id },
      });
      expect((await repo.historico(e.id))[0].evento).toBe('EXECUCAO_CRIADA');
    });

    it('é idempotente para o mesmo messageId (reentrega)', async () => {
      const msg = solicitar();
      await handler.handle(msg);
      await handler.handle(msg);
      expect(repo.execucoes.size).toBe(1);
      expect(repo.outbox).toHaveLength(1);
    });

    it('reenvio do orquestrador (novo messageId) repete a resposta sem duplicar a execução', async () => {
      await handler.handle(solicitar());
      await handler.handle(solicitar());
      expect(repo.execucoes.size).toBe(1);
      expect(repo.eventos()).toEqual(['DiagnosticoIniciado', 'DiagnosticoIniciado']);
      expect(repo.outbox[0].envelope.payload).toEqual(repo.outbox[1].envelope.payload);
    });

    it('execução já cancelada responde DiagnosticoFalhou', async () => {
      await handler.handle(solicitar());
      const e = await execucaoDeOs();
      await handler.handle(
        cmd('CancelarExecucao', { ordemServicoId: 'os-1', execucaoId: e.id, motivo: 'x' }),
      );
      await handler.handle(solicitar());
      expect(ultimo().type).toBe('DiagnosticoFalhou');
    });

    it('dados inválidos respondem DiagnosticoFalhou (sem criar execução)', async () => {
      await handler.handle(solicitar({ clienteId: '' }));
      expect(repo.execucoes.size).toBe(0);
      expect(ultimo()).toMatchObject({
        type: 'DiagnosticoFalhou',
        payload: { ordemServicoId: 'os-1', motivo: expect.stringContaining('clienteId') },
      });
    });

    it('sem ordemServicoId é erro permanente (não há a quem responder)', async () => {
      await expect(handler.handle(cmd('SolicitarDiagnostico', {}))).rejects.toThrow(
        InvalidMessageError,
      );
    });
  });

  describe('IniciarReparo', () => {
    const diagnosticada = async (): Promise<Execucao> => {
      await handler.handle(solicitar());
      const e = await execucaoDeOs();
      e.iniciarDiagnostico();
      e.concluirDiagnostico([{ catalogoServicoId: 's', pecas: [] }]);
      await repo.commit({ execucao: e });
      return (await execucaoDeOs())!;
    };
    const iniciar = (execucaoId?: string, osId = 'os-1', extra: Extra = {}): Envelope =>
      cmd('IniciarReparo', { ordemServicoId: osId, execucaoId }, extra);

    it('enfileira o reparo e responde ReparoIniciado', async () => {
      const e = await diagnosticada();
      await handler.handle(iniciar(e.id));
      expect((await execucaoDeOs()).status).toBe(S.AGUARDANDO_REPARO);
      expect(ultimo()).toMatchObject({ type: 'ReparoIniciado', payload: { execucaoId: e.id } });
    });

    it.each([S.AGUARDANDO_REPARO, S.EM_REPARO, S.CONCLUIDA])(
      'reenvio com a execução em %s repete a confirmação',
      async (estado) => {
        const e = await diagnosticada();
        await handler.handle(iniciar(e.id));
        const atual = await execucaoDeOs();
        if (estado !== S.AGUARDANDO_REPARO) atual.iniciarReparo();
        if (estado === S.CONCLUIDA) atual.concluirReparo();
        await repo.commit({ execucao: atual });
        await handler.handle(iniciar(e.id));
        expect(ultimo().type).toBe('ReparoIniciado');
        expect((await execucaoDeOs()).status).toBe(estado);
      },
    );

    it('execução inexistente ou de outra OS responde ReparoFalhou', async () => {
      await handler.handle(iniciar('nao-existe'));
      expect(ultimo()).toMatchObject({
        type: 'ReparoFalhou',
        payload: { motivo: 'Execução não encontrada' },
      });

      const e = await diagnosticada();
      await handler.handle(iniciar(e.id, 'outra-os'));
      expect(ultimo().type).toBe('ReparoFalhou');
    });

    it('sem execucaoId responde ReparoFalhou', async () => {
      await handler.handle(iniciar(undefined));
      expect(ultimo().type).toBe('ReparoFalhou');
    });

    it('execução ainda sem diagnóstico ou cancelada responde ReparoFalhou', async () => {
      await handler.handle(solicitar());
      const e = await execucaoDeOs();
      await handler.handle(iniciar(e.id));
      expect(ultimo()).toMatchObject({
        type: 'ReparoFalhou',
        payload: { motivo: expect.stringContaining('AGUARDANDO_DIAGNOSTICO') },
      });
      expect((await execucaoDeOs()).status).toBe(S.AGUARDANDO_DIAGNOSTICO);
    });

    it('é idempotente para o mesmo messageId', async () => {
      const e = await diagnosticada();
      const msg = iniciar(e.id);
      await handler.handle(msg);
      const antes = repo.outbox.length;
      await handler.handle(msg);
      expect(repo.outbox).toHaveLength(antes);
    });
  });

  describe('CancelarExecucao', () => {
    const cancelar = (payload: object, extra: Extra = {}): Envelope =>
      cmd(
        'CancelarExecucao',
        { ordemServicoId: 'os-1', motivo: 'cliente desistiu', ...payload },
        extra,
      );

    it('cancela por execucaoId e responde ExecucaoCancelada', async () => {
      await handler.handle(solicitar());
      const e = await execucaoDeOs();
      await handler.handle(cancelar({ execucaoId: e.id }));
      const depois = await execucaoDeOs();
      expect(depois.status).toBe(S.CANCELADA);
      expect(depois.motivo).toBe('cliente desistiu');
      expect(ultimo()).toMatchObject({ type: 'ExecucaoCancelada', payload: { execucaoId: e.id } });
    });

    it('sem execucaoId resolve pela OS (caso DiagnosticoIniciado ainda não chegou ao OS)', async () => {
      await handler.handle(solicitar());
      await handler.handle(cancelar({}));
      expect((await execucaoDeOs()).status).toBe(S.CANCELADA);
    });

    it('execução inexistente: no-op idempotente que ainda responde', async () => {
      await handler.handle(cancelar({}));
      expect(ultimo()).toMatchObject({
        type: 'ExecucaoCancelada',
        payload: { ordemServicoId: 'os-1' },
      });
      expect(repo.execucoes.size).toBe(0);
    });

    it('execução de outra OS não é cancelada', async () => {
      await handler.handle(solicitar());
      const e = await execucaoDeOs();
      await handler.handle(cancelar({ ordemServicoId: 'os-9', execucaoId: e.id }));
      expect((await execucaoDeOs()).status).toBe(S.AGUARDANDO_DIAGNOSTICO);
      expect(ultimo().type).toBe('ExecucaoCancelada');
    });

    it('execução já terminal não muda de estado, mas responde', async () => {
      await handler.handle(solicitar());
      const e = await execucaoDeOs();
      e.cancelar('antes');
      await repo.commit({ execucao: e });
      await handler.handle(cancelar({ execucaoId: e.id, motivo: 'de novo' }));
      expect((await execucaoDeOs()).motivo).toBe('antes');
      expect(ultimo().type).toBe('ExecucaoCancelada');
    });

    it('é idempotente para o mesmo messageId', async () => {
      await handler.handle(solicitar());
      const msg = cancelar({});
      await handler.handle(msg);
      const antes = repo.outbox.length;
      await handler.handle(msg);
      expect(repo.outbox).toHaveLength(antes);
    });

    it('usa motivo padrão quando não informado', async () => {
      await handler.handle(solicitar());
      await handler.handle(cmd('CancelarExecucao', { ordemServicoId: 'os-1' }));
      expect((await execucaoDeOs()).motivo).toBe('Cancelada pela Saga');
    });
  });

  describe('mensagens inválidas (erro permanente → DLQ)', () => {
    it('versão desconhecida', async () => {
      await expect(handler.handle(solicitar({}, { version: 2 }))).rejects.toThrow(
        InvalidMessageError,
      );
    });
    it('tipo desconhecido', async () => {
      await expect(handler.handle(cmd('Abracadabra', { ordemServicoId: 'os-1' }))).rejects.toThrow(
        /desconhecido/,
      );
    });
    it('falha inesperada do repositório é propagada (a mensagem volta à fila)', async () => {
      repo.commit = jest.fn().mockRejectedValue(new Error('dynamo fora do ar'));
      await expect(handler.handle(solicitar())).rejects.toThrow('dynamo fora do ar');
    });
    it('erro não-validação ao criar é propagado', async () => {
      jest.spyOn(Execucao, 'criar').mockImplementationOnce(() => {
        throw new Error('bug');
      });
      await expect(handler.handle(solicitar())).rejects.toThrow('bug');
    });
  });

  it('concorrência: dois comandos simultâneos para a mesma OS resultam em uma execução', async () => {
    const [a, b] = await Promise.allSettled([
      handler.handle(solicitar()),
      handler.handle(solicitar()),
    ]);
    // O segundo pode falhar por conflito (a mensagem seria reentregue) — nunca duplica.
    expect([a.status, b.status]).toContain('fulfilled');
    expect(repo.execucoes.size).toBe(1);
    await handler.handle(solicitar());
    expect(repo.execucoes.size).toBe(1);
  });
});
