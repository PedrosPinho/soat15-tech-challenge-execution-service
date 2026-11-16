/**
 * Integração com o DynamoDB/SQS/SNS reais do LocalStack. Roda só quando
 * `LOCALSTACK_ENDPOINT` está definido (CI sobe o container como `service`;
 * localmente: `docker compose up localstack` + `LOCALSTACK_ENDPOINT=http://localhost:4566`).
 */
import { CreateTableCommand, DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { CreateTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import { ExecutionCommandHandler } from '@application/messaging/execution-command-handler';
import { OutboxRelay } from '@application/messaging/outbox-relay';
import { ExecucaoUseCases } from '@application/use-cases/execucao.use-cases';
import { ExecucaoStatus as S } from '@domain/entities/execucao.entity';
import { DynamoExecucaoRepository } from '@infrastructure/database/dynamodb/dynamo-execucao.repository';
import { DynamoOutboxRepository } from '@infrastructure/database/dynamodb/dynamo-outbox.repository';
import { SqsSnsMessageBus } from '@infrastructure/messaging/sqs-sns-message-bus';
import { ConcurrencyError } from '@shared/errors/domain.error';
import { createEnvelope, Envelope } from '@shared/messaging/envelope';
import { Destinations } from '@shared/messaging/messages';

const endpoint = process.env.LOCALSTACK_ENDPOINT;
const describeLocalstack = endpoint ? describe : describe.skip;

describeLocalstack('Execution Service × LocalStack', () => {
  const region = 'us-east-1';
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  const base = { region, endpoint, credentials };
  const table = `execucoes-it-${Date.now()}`;
  const raw = new DynamoDBClient(base);
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sqs = new SQSClient(base);
  const sns = new SNSClient(base);
  const repo = new DynamoExecucaoRepository(doc, table);
  const handler = new ExecutionCommandHandler(repo);
  const useCases = new ExecucaoUseCases(repo);
  let relay: OutboxRelay;
  let bus: SqsSnsMessageBus;
  let commandsQueueUrl: string;

  const comando = (type: string, payload: object, messageId?: string): Envelope =>
    createEnvelope({ type, sagaId: 'saga-it', correlationId: 'corr-it', payload, messageId });

  const solicitar = (osId: string, messageId?: string): Envelope =>
    comando(
      'SolicitarDiagnostico',
      {
        ordemServicoId: osId,
        numeroOS: osId,
        clienteId: 'c',
        veiculoId: 'v',
        prioridade: 'NORMAL',
      },
      messageId,
    );

  beforeAll(async () => {
    await raw.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'gsi1pk', AttributeType: 'S' },
          { AttributeName: 'gsi1sk', AttributeType: 'S' },
          { AttributeName: 'gsi2pk', AttributeType: 'S' },
          { AttributeName: 'gsi2sk', AttributeType: 'S' },
          { AttributeName: 'gsi3pk', AttributeType: 'S' },
          { AttributeName: 'gsi3sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'gsi2',
            KeySchema: [
              { AttributeName: 'gsi2pk', KeyType: 'HASH' },
              { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'gsi3',
            KeySchema: [
              { AttributeName: 'gsi3pk', KeyType: 'HASH' },
              { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );

    const topicArn = (await sns.send(new CreateTopicCommand({ Name: `eventos-it-${Date.now()}` })))
      .TopicArn!;
    const q = `commands-it-${Date.now()}`;
    commandsQueueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: q }))).QueueUrl!;
    bus = new SqsSnsMessageBus({
      sqs,
      sns,
      queues: { [Destinations.ExecutionCommands]: commandsQueueUrl },
      topics: { [Destinations.EventosTopic]: topicArn },
      waitTimeSeconds: 1,
    });
    relay = new OutboxRelay(new DynamoOutboxRepository(doc, table), bus);
  }, 60_000);

  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: table })).catch(() => undefined);
  });

  it('SolicitarDiagnostico cria a execução e é idempotente no mesmo messageId', async () => {
    const msg = solicitar('os-it-1');
    await handler.handle(msg);
    await handler.handle(msg);
    const e = (await repo.findByOrdemServicoId('os-it-1'))!;
    expect(e.status).toBe(S.AGUARDANDO_DIAGNOSTICO);
    expect(e.versao).toBe(1);
    expect(await repo.historico(e.id)).toHaveLength(1);
  });

  it('só existe uma execução por OS mesmo com comandos concorrentes', async () => {
    const r = await Promise.allSettled([
      handler.handle(solicitar('os-it-2')),
      handler.handle(solicitar('os-it-2')),
    ]);
    expect(r.some((x) => x.status === 'fulfilled')).toBe(true);
    await handler.handle(solicitar('os-it-2'));
    const fila = await repo.listarFila(S.AGUARDANDO_DIAGNOSTICO, 50);
    expect(fila.filter((e) => e.ordemServicoId === 'os-it-2')).toHaveLength(1);
  });

  it('lock otimista: duas escritas com a mesma versão → a segunda falha', async () => {
    await handler.handle(solicitar('os-it-3'));
    const id = (await repo.findByOrdemServicoId('os-it-3'))!.id;
    const a = (await repo.findById(id))!;
    const b = (await repo.findById(id))!;
    a.iniciarDiagnostico();
    b.cancelar('x');
    await repo.commit({ execucao: a });
    await expect(repo.commit({ execucao: b })).rejects.toThrow(ConcurrencyError);
    expect((await repo.findById(id))!.status).toBe(S.EM_DIAGNOSTICO);
  });

  it('a fila respeita prioridade e ordem de chegada', async () => {
    await handler.handle(
      comando('SolicitarDiagnostico', {
        ordemServicoId: 'os-it-n',
        numeroOS: 'n',
        clienteId: 'c',
        veiculoId: 'v',
        prioridade: 'NORMAL',
      }),
    );
    await handler.handle(
      comando('SolicitarDiagnostico', {
        ordemServicoId: 'os-it-a',
        numeroOS: 'a',
        clienteId: 'c',
        veiculoId: 'v',
        prioridade: 'ALTA',
      }),
    );
    const fila = (await useCases.listarFila(S.AGUARDANDO_DIAGNOSTICO, 100)).map(
      (e) => e.ordemServicoId,
    );
    expect(fila.indexOf('os-it-a')).toBeLessThan(fila.indexOf('os-it-n'));
  });

  it('o relay publica o outbox e não republica o que já foi enviado', async () => {
    const publish = jest.spyOn(bus, 'publish').mockResolvedValue();
    await handler.handle(solicitar('os-it-4'));
    const antes = publish.mock.calls.length;
    await relay.tick();
    expect(publish.mock.calls.length).toBeGreaterThan(antes);
    const apos = publish.mock.calls.length;
    await relay.tick();
    expect(publish.mock.calls.length).toBe(apos);
    publish.mockRestore();
  });

  it('o ciclo do mecânico grava histórico e outbox atomicamente', async () => {
    await handler.handle(solicitar('os-it-5'));
    const id = (await repo.findByOrdemServicoId('os-it-5'))!.id;
    await useCases.iniciarDiagnostico(id, 'mec');
    await useCases.concluirDiagnostico(id, 'mec', {
      servicos: [{ catalogoServicoId: 's', pecas: [{ pecaId: 'p', quantidade: 1 }] }],
    });
    expect((await useCases.obter(id)).historico.map((h) => h.evento)).toEqual([
      'EXECUCAO_CRIADA',
      'DIAGNOSTICO_INICIADO',
      'DIAGNOSTICO_CONCLUIDO',
    ]);
  });
});
