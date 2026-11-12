import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ExecutionCommandHandler } from '@application/messaging/execution-command-handler';
import { OutboxRelay } from '@application/messaging/outbox-relay';
import { ExecucaoUseCases } from '@application/use-cases/execucao.use-cases';
import { IMessageBus } from '@domain/services/message-bus';
import { DynamoExecucaoRepository } from '@infrastructure/database/dynamodb/dynamo-execucao.repository';
import { DynamoOutboxRepository } from '@infrastructure/database/dynamodb/dynamo-outbox.repository';
import { InMemoryMessageBus } from '@infrastructure/messaging/in-memory-message-bus';
import { SqsSnsMessageBus } from '@infrastructure/messaging/sqs-sns-message-bus';
import { ExecucaoController } from '@presentation/controllers/execucao.controller';
import { Destinations } from '@shared/messaging/messages';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ${name} é obrigatória`);
  return value;
};

/** `AWS_ENDPOINT_URL` (LocalStack) é lido pelo próprio SDK; região vem do ambiente. */
export const makeDocumentClient = (): DynamoDBDocumentClient =>
  DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

/** `MESSAGING_DRIVER=memory` (testes/dev sem AWS) ou `sqs` (default). */
export const makeMessageBus = (): IMessageBus => {
  if (process.env.MESSAGING_DRIVER === 'memory') return new InMemoryMessageBus();
  const region = process.env.AWS_REGION ?? 'us-east-1';
  return new SqsSnsMessageBus({
    sqs: new SQSClient({ region }),
    sns: new SNSClient({ region }),
    queues: { [Destinations.ExecutionCommands]: required('EXECUTION_COMMANDS_QUEUE_URL') },
    topics: { [Destinations.EventosTopic]: required('EVENTS_TOPIC_ARN') },
  });
};

export interface Runtime {
  repository: DynamoExecucaoRepository;
  controller: ExecucaoController;
  commandHandler: ExecutionCommandHandler;
  relay: OutboxRelay;
  bus: IMessageBus;
}

/** Composition root do serviço. */
export const makeRuntime = (bus: IMessageBus = makeMessageBus()): Runtime => {
  const doc = makeDocumentClient();
  const table = process.env.DYNAMODB_TABLE ?? 'execucoes';
  const repository = new DynamoExecucaoRepository(doc, table);
  const outbox = new DynamoOutboxRepository(doc, table);
  return {
    repository,
    bus,
    controller: new ExecucaoController(new ExecucaoUseCases(repository)),
    commandHandler: new ExecutionCommandHandler(repository),
    relay: new OutboxRelay(outbox, bus, {
      intervalMs: Number(process.env.OUTBOX_RELAY_INTERVAL_MS ?? 1000),
    }),
  };
};
