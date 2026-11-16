import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { IOutboxRepository, OutboxEntry } from '@domain/repositories/execucao.repository';
import { parseEnvelopeFromJson } from '@shared/messaging/envelope';
import { logger } from '@shared/logger';
import {
  INDEX_OUTBOX,
  META,
  OUTBOX_PENDENTE,
  OUTBOX_PUBLICADO_TTL_SEGUNDOS,
  pkOutbox,
} from './keys';

/**
 * Outbox no DynamoDB. As pendentes ficam no GSI3 (índice esparso: `gsi3pk` só
 * existe enquanto pendente). Para 2+ réplicas não publicarem a mesma mensagem, o
 * relay reivindica cada item com um *lease* condicional (`lockedUntil`) — o
 * equivalente do `FOR UPDATE SKIP LOCKED` do Postgres.
 */
export class DynamoOutboxRepository implements IOutboxRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async claimBatch(limit: number, leaseMs: number): Promise<OutboxEntry[]> {
    const agora = this.clock().toISOString();
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: INDEX_OUTBOX,
        KeyConditionExpression: 'gsi3pk = :pk',
        FilterExpression:
          '(attribute_not_exists(proximaTentativaEm) OR proximaTentativaEm <= :now)' +
          ' AND (attribute_not_exists(lockedUntil) OR lockedUntil < :now)',
        ExpressionAttributeValues: { ':pk': OUTBOX_PENDENTE, ':now': agora },
        ScanIndexForward: true,
        Limit: Math.max(limit * 3, 10),
      }),
    );

    const lease = new Date(this.clock().getTime() + leaseMs).toISOString();
    const claimed: OutboxEntry[] = [];
    for (const item of Items ?? []) {
      if (claimed.length >= limit) break;
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { PK: item.PK, SK: META },
            UpdateExpression: 'SET lockedUntil = :lease',
            ConditionExpression:
              'attribute_exists(gsi3pk) AND (attribute_not_exists(lockedUntil) OR lockedUntil < :now)',
            ExpressionAttributeValues: { ':lease': lease, ':now': agora },
          }),
        );
        claimed.push({
          id: (item.PK as string).replace('OUTBOX#', ''),
          envelope: parseEnvelopeFromJson(item.envelope as string),
          tentativas: (item.tentativas as number) ?? 0,
        });
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) continue; // outra réplica pegou
        logger.error({ error, pk: item.PK }, 'Falha ao reivindicar item do outbox');
      }
    }
    return claimed;
  }

  async markPublished(id: string): Promise<void> {
    const agora = this.clock();
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: pkOutbox(id), SK: META },
        UpdateExpression: 'SET publicadoEm = :now, #ttl = :ttl REMOVE gsi3pk, gsi3sk, lockedUntil',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':now': agora.toISOString(),
          ':ttl': Math.floor(agora.getTime() / 1000) + OUTBOX_PUBLICADO_TTL_SEGUNDOS,
        },
      }),
    );
  }

  async markFailed(id: string, erro: string, proximaTentativaEm: Date): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: pkOutbox(id), SK: META },
        UpdateExpression:
          'SET tentativas = if_not_exists(tentativas, :zero) + :one, ultimoErro = :erro, proximaTentativaEm = :proxima REMOVE lockedUntil',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':erro': erro.slice(0, 500),
          ':proxima': proximaTentativaEm.toISOString(),
        },
      }),
    );
  }
}
