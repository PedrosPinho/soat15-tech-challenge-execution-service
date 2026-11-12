import { ExecutionCommandHandler } from '@application/messaging/execution-command-handler';
import { ExecucaoUseCases } from '@application/use-cases/execucao.use-cases';
import { Envelope } from '@shared/messaging/envelope';
import { FakeExecucaoRepository } from '../support/fake-repositories';
import { conferirContrato, lerContrato, normalizar, primeiroDeCada } from './normalize';

/**
 * Consumidor dos comandos do OS (`os-commands.json`, copiado do repo do OS) e PRODUTOR dos
 * eventos de Execution (`execution-events.json`, copiado para o repo do OS). Os comandos reais
 * do OS alimentam o handler real; os eventos resultantes são o contrato que o OS consome.
 */
describe('contrato: Execution ↔ OS', () => {
  const comandos = lerContrato('os-commands.json');
  const cmd = (type: string, patch: Record<string, unknown> = {}): Envelope => {
    const c = comandos.find((x) => x.type === type)!;
    return {
      ...c,
      messageId: crypto.randomUUID(),
      payload: { ...(c.payload as object), ...patch },
    };
  };
  const repo = new FakeExecucaoRepository();
  const handler = new ExecutionCommandHandler(repo);
  const uc = new ExecucaoUseCases(repo);
  const servicos = [{ catalogoServicoId: 'cat-1', pecas: [{ pecaId: 'peca-1', quantidade: 2 }] }];
  const emitidos = (): Envelope[] => repo.outbox.map((o) => o.envelope);

  it('o handler aceita os comandos reais do OS e os eventos batem com o contrato', async () => {
    // OS 1: diagnóstico -> reparo concluído
    await handler.handle(cmd('SolicitarDiagnostico'));
    const e1 = (await repo.findByOrdemServicoId('os-1'))!;
    await uc.iniciarDiagnostico(e1.id, 'mec');
    await uc.concluirDiagnostico(e1.id, 'mec', { servicos });
    await handler.handle(cmd('IniciarReparo', { execucaoId: e1.id }));
    await uc.iniciarReparo(e1.id, 'mec');
    await uc.concluirReparo(e1.id, 'mec', 'tudo certo');

    // OS 2: diagnóstico falha; OS 3: reparo falha; cancelamento
    await handler.handle(cmd('SolicitarDiagnostico', { ordemServicoId: 'os-2' }));
    const e2 = (await repo.findByOrdemServicoId('os-2'))!;
    await uc.iniciarDiagnostico(e2.id, 'mec');
    await uc.falharDiagnostico(e2.id, 'mec', 'sem acesso ao veículo');

    await handler.handle(cmd('SolicitarDiagnostico', { ordemServicoId: 'os-3' }));
    const e3 = (await repo.findByOrdemServicoId('os-3'))!;
    await uc.iniciarDiagnostico(e3.id, 'mec');
    await uc.concluirDiagnostico(e3.id, 'mec', { servicos });
    await handler.handle(cmd('IniciarReparo', { ordemServicoId: 'os-3', execucaoId: e3.id }));
    await uc.iniciarReparo(e3.id, 'mec');
    await uc.falharReparo(e3.id, 'mec', 'motor fundido');
    await handler.handle(cmd('CancelarExecucao', { ordemServicoId: 'os-3', execucaoId: e3.id }));

    const porTipo = primeiroDeCada(emitidos());
    expect(porTipo.map((e) => e.type).sort()).toEqual([
      'DiagnosticoConcluido',
      'DiagnosticoFalhou',
      'DiagnosticoIniciado',
      'ExecucaoCancelada',
      'ReparoConcluido',
      'ReparoFalhou',
      'ReparoIniciado',
    ]);
    conferirContrato('execution-events.json', normalizar(porTipo));
  });

  it('cada comando do OS para o Execution é reconhecido (nenhum cai em "desconhecido")', async () => {
    for (const type of ['SolicitarDiagnostico', 'IniciarReparo', 'CancelarExecucao']) {
      await expect(
        handler.handle(cmd(type, { ordemServicoId: `os-${type}`, execucaoId: undefined })),
      ).resolves.toBeUndefined();
    }
  });
});
