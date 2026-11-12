import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoOutboxRepository } from '@infrastructure/database/dynamodb/dynamo-outbox.repository';
import { createEnvelope } from '@shared/messaging/envelope';

const AGORA = new Date('2026-11-12T10:00:00.000Z');

describe('DynamoOutboxRepository', () => {
  const send = jest.fn();
  const repo = new DynamoOutboxRepository(
    { send } as unknown as DynamoDBDocumentClient,
    'execucoes',
    () => AGORA,
  );
  const env = (n: number) =>
    createEnvelope({
      type: 'DiagnosticoIniciado',
      sagaId: 's',
      correlationId: 'c',
      payload: { n },
      messageId: `m${n}`,
    });
  const item = (n: number, tentativas?: number) => ({
    PK: `OUTBOX#m${n}`,
    SK: 'META',
    envelope: JSON.stringify(env(n)),
    tentativas,
  });

  beforeEach(() => send.mockReset());

  it('claimBatch consulta o GSI esparso e reivindica cada item com lease condicional', async () => {
    send.mockResolvedValueOnce({ Items: [item(1, 2), item(2)] }).mockResolvedValue({});

    const batch = await repo.claimBatch(10, 30_000);

    expect(batch.map((b) => [b.id, b.tentativas])).toEqual([
      ['m1', 2],
      ['m2', 0],
    ]);
    expect(batch[0].envelope.type).toBe('DiagnosticoIniciado');
    const q = send.mock.calls[0][0] as QueryCommand;
    expect(q.input).toMatchObject({ IndexName: 'gsi3', ScanIndexForward: true });
    expect(q.input.ExpressionAttributeValues).toMatchObject({ ':pk': 'OUTBOX#PENDING' });
    const claim = send.mock.calls[1][0] as UpdateCommand;
    expect(claim.input.ExpressionAttributeValues).toEqual({
      ':lease': '2026-11-12T10:00:30.000Z',
      ':now': '2026-11-12T10:00:00.000Z',
    });
    expect(claim.input.ConditionExpression).toContain('lockedUntil < :now');
  });

  it('respeita o limite e ignora itens que outra réplica já reivindicou', async () => {
    send
      .mockResolvedValueOnce({ Items: [item(1), item(2), item(3)] })
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }))
      .mockResolvedValue({});
    const batch = await repo.claimBatch(1, 1000);
    expect(batch.map((b) => b.id)).toEqual(['m2']);
  });

  it('erro inesperado ao reivindicar um item não derruba o lote', async () => {
    send
      .mockResolvedValueOnce({ Items: [item(1), item(2)] })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({});
    expect((await repo.claimBatch(5, 1000)).map((b) => b.id)).toEqual(['m2']);
  });

  it('sem pendências devolve lista vazia', async () => {
    send.mockResolvedValue({});
    expect(await repo.claimBatch(5, 1000)).toEqual([]);
  });

  it('markPublished remove do índice pendente e define TTL', async () => {
    send.mockResolvedValue({});
    await repo.markPublished('m1');
    const u = (send.mock.calls[0][0] as UpdateCommand).input;
    expect(u.Key).toEqual({ PK: 'OUTBOX#m1', SK: 'META' });
    expect(u.UpdateExpression).toContain('REMOVE gsi3pk, gsi3sk, lockedUntil');
    expect(u.ExpressionAttributeValues![':ttl']).toBe(
      Math.floor(AGORA.getTime() / 1000) + 7 * 24 * 3600,
    );
  });

  it('markFailed incrementa tentativas, agenda a próxima e libera o lease', async () => {
    send.mockResolvedValue({});
    await repo.markFailed('m1', 'x'.repeat(900), new Date('2026-11-12T10:01:00.000Z'));
    const u = (send.mock.calls[0][0] as UpdateCommand).input;
    expect(u.UpdateExpression).toContain('REMOVE lockedUntil');
    expect(u.ExpressionAttributeValues![':proxima']).toBe('2026-11-12T10:01:00.000Z');
    expect((u.ExpressionAttributeValues![':erro'] as string).length).toBe(500);
  });
});
