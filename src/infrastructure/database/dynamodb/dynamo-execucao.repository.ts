import { randomUUID } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { Execucao, ExecucaoProps, ExecucaoStatus } from '@domain/entities/execucao.entity';
import {
  CommitInput,
  HistoricoEvento,
  IExecucaoRepository,
} from '@domain/repositories/execucao.repository';
import { ConcurrencyError, DuplicateMessageError } from '@shared/errors/domain.error';
import {
  gsi1pk,
  gsi1sk,
  gsi2pk,
  INBOX_TTL_SEGUNDOS,
  INDEX_FILA,
  INDEX_OS,
  META,
  OUTBOX_PENDENTE,
  pkExecucao,
  pkInbox,
  pkOutbox,
  pkTravaOs,
  skEvento,
} from './keys';

type Item = Record<string, unknown>;
type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

type Origem = 'inbox' | 'execucao' | 'trava' | 'outro';

const toItem = (e: Execucao): Item => {
  const p = e.toProps();
  return {
    PK: pkExecucao(p.id),
    SK: META,
    entidade: 'EXECUCAO',
    gsi1pk: gsi1pk(p.status),
    gsi1sk: gsi1sk(p.prioridade, p.criadoEm, p.id),
    gsi2pk: gsi2pk(p.ordemServicoId),
    gsi2sk: 'EXEC',
    ...p,
    versao: p.versao + 1,
    criadoEm: p.criadoEm.toISOString(),
    atualizadoEm: p.atualizadoEm.toISOString(),
  };
};

const fromItem = (i: Item): Execucao =>
  Execucao.restaurar({
    id: i.id,
    ordemServicoId: i.ordemServicoId,
    numeroOS: i.numeroOS,
    clienteId: i.clienteId,
    veiculoId: i.veiculoId,
    placa: i.placa,
    descricaoProblema: i.descricaoProblema,
    prioridade: i.prioridade,
    status: i.status,
    sagaId: i.sagaId,
    diagnostico: i.diagnostico,
    observacoesReparo: i.observacoesReparo,
    motivo: i.motivo,
    versao: i.versao,
    criadoEm: new Date(i.criadoEm as string),
    atualizadoEm: new Date(i.atualizadoEm as string),
  } as ExecucaoProps);

const fromHistorico = (i: Item): HistoricoEvento => ({
  evento: i.evento as string,
  statusAnterior: i.statusAnterior as ExecucaoStatus | undefined,
  statusNovo: i.statusNovo as ExecucaoStatus | undefined,
  detalhes: i.detalhes as Record<string, unknown> | undefined,
  ocorridoEm: new Date(i.ocorridoEm as string),
  autor: i.autor as string,
});

/**
 * Repositório DynamoDB (single-table). Toda gravação é uma `TransactWriteItems`
 * única: estado do agregado + histórico + mensagens do outbox + inbox. Assim
 * "mudei o estado mas não registrei o evento" (e o inverso) não existe, e a
 * idempotência do consumidor é atômica com o efeito.
 */
export class DynamoExecucaoRepository implements IExecucaoRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async findById(id: string): Promise<Execucao | null> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: pkExecucao(id), SK: META } }),
    );
    return Item ? fromItem(Item) : null;
  }

  async findByOrdemServicoId(ordemServicoId: string): Promise<Execucao | null> {
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: INDEX_OS,
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: { ':pk': gsi2pk(ordemServicoId) },
        Limit: 1,
      }),
    );
    return Items?.[0] ? fromItem(Items[0]) : null;
  }

  async listarFila(status: ExecucaoStatus, limit: number): Promise<Execucao[]> {
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: INDEX_FILA,
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': gsi1pk(status) },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return (Items ?? []).map(fromItem);
  }

  async historico(execucaoId: string): Promise<HistoricoEvento[]> {
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :evt)',
        ExpressionAttributeValues: { ':pk': pkExecucao(execucaoId), ':evt': 'EVT#' },
        ScanIndexForward: true,
      }),
    );
    return (Items ?? []).map(fromHistorico);
  }

  async commit(input: CommitInput): Promise<void> {
    const itens: TransactItem[] = [];
    const origens: Origem[] = [];
    const add = (item: TransactItem, origem: Origem): void => {
      itens.push(item);
      origens.push(origem);
    };
    const agora = this.clock();

    if (input.inboxMessageId) {
      add(
        {
          Put: {
            TableName: this.table,
            Item: {
              PK: pkInbox(input.inboxMessageId),
              SK: META,
              entidade: 'INBOX',
              processadoEm: agora.toISOString(),
              ttl: Math.floor(agora.getTime() / 1000) + INBOX_TTL_SEGUNDOS,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        'inbox',
      );
    }

    const { execucao } = input;
    if (execucao) {
      // Lock otimista: item novo (não existe) ou versão lida == versão gravada.
      add(
        {
          Put: {
            TableName: this.table,
            Item: toItem(execucao),
            ConditionExpression: 'attribute_not_exists(PK) OR versao = :v',
            ExpressionAttributeValues: { ':v': execucao.versao },
          },
        },
        'execucao',
      );
      if (execucao.versao === 0) {
        // Uma execução por OS, mesmo com dois SolicitarDiagnostico concorrentes.
        add(
          {
            Put: {
              TableName: this.table,
              Item: {
                PK: pkTravaOs(execucao.ordemServicoId),
                SK: META,
                entidade: 'TRAVA_OS',
                execucaoId: execucao.id,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          'trava',
        );
      }
      for (const h of input.historico ?? []) {
        add(
          {
            Put: {
              TableName: this.table,
              Item: {
                PK: pkExecucao(execucao.id),
                SK: skEvento(h.ocorridoEm.toISOString(), randomUUID().slice(0, 8)),
                entidade: 'HISTORICO',
                ...h,
                ocorridoEm: h.ocorridoEm.toISOString(),
              },
            },
          },
          'outro',
        );
      }
    }

    for (const m of input.mensagens ?? []) {
      add(
        {
          Put: {
            TableName: this.table,
            Item: {
              PK: pkOutbox(m.messageId),
              SK: META,
              entidade: 'OUTBOX',
              gsi3pk: OUTBOX_PENDENTE,
              gsi3sk: `${agora.toISOString()}#${m.messageId}`,
              envelope: JSON.stringify(m),
              tentativas: 0,
              criadoEm: agora.toISOString(),
            },
          },
        },
        'outro',
      );
    }

    if (itens.length === 0) return;

    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: itens }));
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const falhas = (error.CancellationReasons ?? []).map(
          (r) => r.Code === 'ConditionalCheckFailed',
        );
        if (falhas[origens.indexOf('inbox')]) {
          throw new DuplicateMessageError(`Mensagem ${input.inboxMessageId} já processada`);
        }
        if (falhas.some(Boolean)) {
          throw new ConcurrencyError(
            execucao
              ? `Execução ${execucao.id} foi alterada por outro processo`
              : 'Conflito de gravação',
          );
        }
      }
      throw error;
    }
    execucao?.registrarPersistencia();
  }

  /** Verificação de conectividade para a readiness probe. */
  async ping(): Promise<boolean> {
    await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: pkExecucao('ping'), SK: META } }),
    );
    return true;
  }
}
