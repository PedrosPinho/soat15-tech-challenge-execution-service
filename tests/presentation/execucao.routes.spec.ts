import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../src/app';
import { ExecucaoUseCases } from '@application/use-cases/execucao.use-cases';
import { Execucao, ExecucaoStatus as S } from '@domain/entities/execucao.entity';
import { ExecucaoController } from '@presentation/controllers/execucao.controller';
import { FakeExecucaoRepository } from '../support/fake-repositories';

const SECRET = 'test-secret';

describe('rotas /api/execucoes', () => {
  let repo: FakeExecucaoRepository;
  let app: ReturnType<typeof createApp>;
  let id: string;
  const interno = `Bearer ${jwt.sign({ sub: 'mec-7', email: 'm@o.com', scope: 'interno' }, SECRET)}`;
  const cliente = `Bearer ${jwt.sign({ sub: 'c-1', cpf: '52998224725', scope: 'cliente' }, SECRET)}`;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  beforeEach(async () => {
    repo = new FakeExecucaoRepository();
    app = createApp({ execucaoController: new ExecucaoController(new ExecucaoUseCases(repo)) });
    const e = Execucao.criar({
      ordemServicoId: 'os-1',
      numeroOS: 'OS-1',
      clienteId: 'c',
      veiculoId: 'v',
      prioridade: 'NORMAL',
      sagaId: 'saga-1',
    });
    await repo.commit({ execucao: e });
    id = e.id;
  });

  it('exige autenticação (401) e escopo interno (403)', async () => {
    expect((await request(app).get('/api/execucoes/fila')).status).toBe(401);
    expect(
      (await request(app).get('/api/execucoes/fila').set('Authorization', cliente)).status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/execucoes/fila').set('Authorization', 'Bearer lixo')).status,
    ).toBe(401);
  });

  it('GET /fila lista por status (padrão AGUARDANDO_DIAGNOSTICO)', async () => {
    const res = await request(app).get('/api/execucoes/fila').set('Authorization', interno);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id, status: S.AGUARDANDO_DIAGNOSTICO });

    const vazia = await request(app)
      .get('/api/execucoes/fila?status=EM_REPARO&limit=5')
      .set('Authorization', interno);
    expect(vazia.body.data).toEqual([]);
  });

  it.each([['status=NADA'], ['limit=0'], ['limit=101'], ['limit=abc']])(
    'GET /fila?%s → 400',
    async (q) => {
      const res = await request(app).get(`/api/execucoes/fila?${q}`).set('Authorization', interno);
      expect(res.status).toBe(400);
    },
  );

  it('GET /:id devolve a execução com histórico; inexistente → 404', async () => {
    await request(app)
      .patch(`/api/execucoes/${id}/diagnostico/iniciar`)
      .set('Authorization', interno);
    const res = await request(app).get(`/api/execucoes/${id}`).set('Authorization', interno);
    expect(res.status).toBe(200);
    expect(res.body.data.historico[0]).toMatchObject({
      evento: 'DIAGNOSTICO_INICIADO',
      autor: 'mec-7',
    });
    expect(
      (await request(app).get('/api/execucoes/nao-existe').set('Authorization', interno)).status,
    ).toBe(404);
  });

  it('fluxo do mecânico: iniciar → concluir diagnóstico gera o evento', async () => {
    const auth = { Authorization: interno };
    expect(
      (await request(app).patch(`/api/execucoes/${id}/diagnostico/iniciar`).set(auth)).body.data
        .status,
    ).toBe(S.EM_DIAGNOSTICO);

    const res = await request(app)
      .patch(`/api/execucoes/${id}/diagnostico/concluir`)
      .set(auth)
      .send({
        servicos: [{ catalogoServicoId: 's-1', pecas: [{ pecaId: 'p-1', quantidade: 2 }] }],
        observacoes: 'ok',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(S.DIAGNOSTICADA);
    expect(repo.eventos()).toEqual(['DiagnosticoConcluido']);
  });

  it('diagnóstico inválido → 400 sem alterar estado', async () => {
    await request(app)
      .patch(`/api/execucoes/${id}/diagnostico/iniciar`)
      .set('Authorization', interno);
    for (const body of [
      {},
      { servicos: [] },
      { servicos: [{}] },
      { servicos: [{ catalogoServicoId: 's', pecas: [{ pecaId: 'p', quantidade: 0 }] }] },
      { servicos: [{ catalogoServicoId: 's', pecas: 'x' }] },
    ]) {
      const res = await request(app)
        .patch(`/api/execucoes/${id}/diagnostico/concluir`)
        .set('Authorization', interno)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect((await repo.findById(id))!.status).toBe(S.EM_DIAGNOSTICO);
  });

  it('falhar exige motivo; com motivo publica DiagnosticoFalhou', async () => {
    await request(app)
      .patch(`/api/execucoes/${id}/diagnostico/iniciar`)
      .set('Authorization', interno);
    expect(
      (
        await request(app)
          .patch(`/api/execucoes/${id}/diagnostico/falhar`)
          .set('Authorization', interno)
          .send({})
      ).status,
    ).toBe(400);
    const ok = await request(app)
      .patch(`/api/execucoes/${id}/diagnostico/falhar`)
      .set('Authorization', interno)
      .send({ motivo: 'sem acesso' });
    expect(ok.status).toBe(200);
    expect(repo.eventos()).toEqual(['DiagnosticoFalhou']);
  });

  it('transição inválida → 422', async () => {
    const res = await request(app)
      .patch(`/api/execucoes/${id}/reparo/concluir`)
      .set('Authorization', interno)
      .send({});
    expect(res.status).toBe(422);
  });

  it('reparo: iniciar → concluir e falhar', async () => {
    const e = (await repo.findById(id))!;
    e.iniciarDiagnostico();
    e.concluirDiagnostico([{ catalogoServicoId: 's', pecas: [] }]);
    e.enfileirarReparo();
    await repo.commit({ execucao: e });

    const auth = { Authorization: interno };
    expect(
      (await request(app).patch(`/api/execucoes/${id}/reparo/iniciar`).set(auth)).body.data.status,
    ).toBe(S.EM_REPARO);
    const conclui = await request(app)
      .patch(`/api/execucoes/${id}/reparo/concluir`)
      .set(auth)
      .send({ observacoes: 'feito' });
    expect(conclui.body.data).toMatchObject({ status: S.CONCLUIDA, observacoesReparo: 'feito' });
    expect(repo.eventos()).toEqual(['ReparoConcluido']);
  });

  it('reparo/falhar publica ReparoFalhou', async () => {
    const e = (await repo.findById(id))!;
    e.iniciarDiagnostico();
    e.concluirDiagnostico([{ catalogoServicoId: 's', pecas: [] }]);
    e.enfileirarReparo();
    e.iniciarReparo();
    await repo.commit({ execucao: e });
    const res = await request(app)
      .patch(`/api/execucoes/${id}/reparo/falhar`)
      .set('Authorization', interno)
      .send({ motivo: 'quebrou' });
    expect(res.status).toBe(200);
    expect(repo.eventos()).toEqual(['ReparoFalhou']);
  });

  it('observacoes longas ou de tipo errado → 400', async () => {
    const e = (await repo.findById(id))!;
    e.iniciarDiagnostico();
    e.concluirDiagnostico([{ catalogoServicoId: 's', pecas: [] }]);
    e.enfileirarReparo();
    e.iniciarReparo();
    await repo.commit({ execucao: e });
    for (const observacoes of [123, 'x'.repeat(1001)]) {
      const res = await request(app)
        .patch(`/api/execucoes/${id}/reparo/concluir`)
        .set('Authorization', interno)
        .send({ observacoes });
      expect(res.status).toBe(400);
    }
  });

  it('sem controller as rotas de negócio não existem (apenas infraestrutura)', async () => {
    expect((await request(createApp()).get('/api/execucoes/fila')).status).toBe(404);
  });
});
