import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Execucao, ExecucaoStatus as S } from '@domain/entities/execucao.entity';
import { DynamoExecucaoRepository } from '@infrastructure/database/dynamodb/dynamo-execucao.repository';
import { ConcurrencyError, DuplicateMessageError } from '@shared/errors/domain.error';
import { createEnvelope } from '@shared/messaging/envelope';

const AGORA = new Date('2026-11-12T10:00:00.000Z');

const cancelamento = (codes: string[]): TransactionCanceledException =>
  new TransactionCanceledException({
    message: 'cancelada',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('DynamoExecucaoRepository', () => {
  const send = jest.fn();
  const repo = new DynamoExecucaoRepository(
    { send } as unknown as DynamoDBDocumentClient,
    'execucoes',
    () => AGORA,
  );

  const nova = (): Execucao =>
    Execucao.criar({
      ordemServicoId: 'os-1',
      numeroOS: 'OS-1',
      clienteId: 'c',
      veiculoId: 'v',
      prioridade: 'ALTA',
      sagaId: 'saga',
    });
  const evento = (): ReturnType<typeof createEnvelope> =>
    createEnvelope({
      type: 'DiagnosticoIniciado',
      sagaId: 'saga',
      correlationId: 'c',
      payload: { ordemServicoId: 'os-1' },
    });
  const comandoEnviado = <T>(i = 0): T => send.mock.calls[i][0] as T;

  beforeEach(() => send.mockReset());

  describe('commit', () => {
    it('execução nova: inbox + execução + trava da OS + histórico + outbox em UMA transação', async () => {
      send.mockResolvedValue({});
      const e = nova();
      const m = evento();
      await repo.commit({
        execucao: e,
        inboxMessageId: 'msg-1',
        historico: [
          {
            evento: 'EXECUCAO_CRIADA',
            ocorridoEm: AGORA,
            autor: 'sistema',
            statusNovo: S.AGUARDANDO_DIAGNOSTICO,
          },
        ],
        mensagens: [m],
      });

      expect(send).toHaveBeenCalledTimes(1);
      const items = comandoEnviado<TransactWriteCommand>().input.TransactItems!;
      const puts = items.map((i) => i.Put!.Item!);
      expect(puts.map((p) => p.PK)).toEqual([
        'INBOX#msg-1',
        `EXEC#${e.id}`,
        'OSLOCK#os-1',
        `EXEC#${e.id}`,
        `OUTBOX#${m.messageId}`,
      ]);
      expect(items[0].Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
      expect(puts[0].ttl).toBe(Math.floor(AGORA.getTime() / 1000) + 7 * 24 * 3600);

      const exec = puts[1];
      expect(exec).toMatchObject({
        SK: 'META',
        status: S.AGUARDANDO_DIAGNOSTICO,
        versao: 1,
        gsi1pk: `STATUS#${S.AGUARDANDO_DIAGNOSTICO}`,
        gsi1sk: expect.stringMatching(/^0#2026-.*#/),
        gsi2pk: 'OS#os-1',
      });
      expect(items[1].Put!.ConditionExpression).toBe('attribute_not_exists(PK) OR versao = :v');
      expect(items[1].Put!.ExpressionAttributeValues).toEqual({ ':v': 0 });
      expect(puts[3].SK).toMatch(/^EVT#2026-11-12T10:00:00.000Z#/);
      expect(puts[4]).toMatchObject({
        gsi3pk: 'OUTBOX#PENDING',
        tentativas: 0,
        envelope: JSON.stringify(m),
      });
      expect(e.versao).toBe(1);
    });

    it('execução existente: sem trava da OS, condição com a versão lida e incrementa', async () => {
      send.mockResolvedValue({});
      const e = Execucao.restaurar({ ...nova().toProps(), versao: 3 });
      e.iniciarDiagnostico(AGORA);
      await repo.commit({ execucao: e });
      const items = comandoEnviado<TransactWriteCommand>().input.TransactItems!;
      expect(items).toHaveLength(1);
      expect(items[0].Put!.ExpressionAttributeValues).toEqual({ ':v': 3 });
      expect(items[0].Put!.Item).toMatchObject({
        versao: 4,
        status: S.EM_DIAGNOSTICO,
        gsi1sk: expect.stringMatching(/^0#/),
      });
      expect(e.versao).toBe(4);
    });

    it('prioridade NORMAL ordena depois de ALTA na chave do GSI', async () => {
      send.mockResolvedValue({});
      const e = Execucao.criar({
        ordemServicoId: 'o',
        numeroOS: 'n',
        clienteId: 'c',
        veiculoId: 'v',
        prioridade: 'NORMAL',
        sagaId: 's',
      });
      await repo.commit({ execucao: e });
      expect(
        comandoEnviado<TransactWriteCommand>().input.TransactItems![0].Put!.Item!.gsi1sk,
      ).toMatch(/^1#/);
    });

    it('só resposta (sem execução): inbox + outbox', async () => {
      send.mockResolvedValue({});
      await repo.commit({ inboxMessageId: 'm', mensagens: [evento()] });
      expect(comandoEnviado<TransactWriteCommand>().input.TransactItems).toHaveLength(2);
    });

    it('nada para gravar não chama o DynamoDB', async () => {
      await repo.commit({});
      expect(send).not.toHaveBeenCalled();
    });

    it('inbox já existente → DuplicateMessageError, sem incrementar a versão', async () => {
      send.mockRejectedValue(cancelamento(['ConditionalCheckFailed', 'None', 'None']));
      const e = nova();
      await expect(repo.commit({ execucao: e, inboxMessageId: 'm' })).rejects.toThrow(
        DuplicateMessageError,
      );
      expect(e.versao).toBe(0);
    });

    it('versão divergente → ConcurrencyError', async () => {
      send.mockRejectedValue(cancelamento(['None', 'ConditionalCheckFailed']));
      await expect(repo.commit({ execucao: nova(), inboxMessageId: 'm' })).rejects.toThrow(
        ConcurrencyError,
      );
    });

    it('OS que já tem execução (trava) → ConcurrencyError', async () => {
      send.mockRejectedValue(cancelamento(['None', 'None', 'ConditionalCheckFailed']));
      await expect(repo.commit({ execucao: nova() })).rejects.toThrow(ConcurrencyError);
    });

    it('conflito sem execução usa mensagem genérica', async () => {
      send.mockRejectedValue(cancelamento(['ConditionalCheckFailed']));
      await expect(repo.commit({ mensagens: [evento()] })).rejects.toThrow('Conflito de gravação');
    });

    it('cancelamento por outro motivo (throttling) e erros desconhecidos são propagados', async () => {
      send.mockRejectedValueOnce(cancelamento(['ThrottlingError']));
      await expect(repo.commit({ execucao: nova() })).rejects.toBeInstanceOf(
        TransactionCanceledException,
      );
      send.mockRejectedValueOnce(new Error('rede'));
      await expect(repo.commit({ execucao: nova() })).rejects.toThrow('rede');
    });

    it('TransactionCanceledException sem motivos é propagada', async () => {
      send.mockRejectedValue(new TransactionCanceledException({ message: 'x', $metadata: {} }));
      await expect(repo.commit({ execucao: nova() })).rejects.toBeInstanceOf(
        TransactionCanceledException,
      );
    });
  });

  describe('leituras', () => {
    const item = {
      PK: 'EXEC#e1',
      SK: 'META',
      id: 'e1',
      ordemServicoId: 'os-1',
      numeroOS: 'OS-1',
      clienteId: 'c',
      veiculoId: 'v',
      prioridade: 'NORMAL',
      status: S.EM_REPARO,
      sagaId: 'saga',
      versao: 5,
      criadoEm: '2026-11-12T09:00:00.000Z',
      atualizadoEm: '2026-11-12T09:30:00.000Z',
    };

    it('findById: encontra e mapeia datas', async () => {
      send.mockResolvedValue({ Item: item });
      const e = await repo.findById('e1');
      expect(comandoEnviado<GetCommand>().input.Key).toEqual({ PK: 'EXEC#e1', SK: 'META' });
      expect(e).toMatchObject({ id: 'e1', status: S.EM_REPARO, versao: 5 });
      expect(e!.criadoEm).toEqual(new Date('2026-11-12T09:00:00.000Z'));
    });

    it('findById: inexistente → null', async () => {
      send.mockResolvedValue({});
      expect(await repo.findById('x')).toBeNull();
    });

    it('findByOrdemServicoId usa o GSI por OS', async () => {
      send.mockResolvedValue({ Items: [item] });
      expect((await repo.findByOrdemServicoId('os-1'))!.id).toBe('e1');
      const q = comandoEnviado<QueryCommand>().input;
      expect(q.IndexName).toBe('gsi2');
      expect(q.ExpressionAttributeValues).toEqual({ ':pk': 'OS#os-1' });
      send.mockResolvedValue({ Items: [] });
      expect(await repo.findByOrdemServicoId('os-2')).toBeNull();
    });

    it('listarFila consulta o GSI da fila em ordem crescente', async () => {
      send.mockResolvedValue({ Items: [item, item] });
      expect(await repo.listarFila(S.AGUARDANDO_REPARO, 5)).toHaveLength(2);
      const q = comandoEnviado<QueryCommand>().input;
      expect(q).toMatchObject({ IndexName: 'gsi1', ScanIndexForward: true, Limit: 5 });
      expect(q.ExpressionAttributeValues).toEqual({ ':pk': 'STATUS#AGUARDANDO_REPARO' });
      send.mockResolvedValue({});
      expect(await repo.listarFila(S.AGUARDANDO_REPARO, 5)).toEqual([]);
    });

    it('historico lê os itens EVT# da execução', async () => {
      send.mockResolvedValue({
        Items: [
          {
            evento: 'X',
            statusNovo: S.CONCLUIDA,
            ocorridoEm: '2026-11-12T09:00:00.000Z',
            autor: 'a',
          },
        ],
      });
      const h = await repo.historico('e1');
      expect(h).toEqual([
        {
          evento: 'X',
          statusAnterior: undefined,
          statusNovo: S.CONCLUIDA,
          detalhes: undefined,
          ocorridoEm: new Date('2026-11-12T09:00:00.000Z'),
          autor: 'a',
        },
      ]);
      expect(comandoEnviado<QueryCommand>().input.ExpressionAttributeValues).toEqual({
        ':pk': 'EXEC#e1',
        ':evt': 'EVT#',
      });
      send.mockResolvedValue({});
      expect(await repo.historico('e1')).toEqual([]);
    });

    it('ping consulta uma chave qualquer', async () => {
      send.mockResolvedValue({});
      expect(await repo.ping()).toBe(true);
      send.mockRejectedValue(new Error('down'));
      await expect(repo.ping()).rejects.toThrow('down');
    });
  });
});
