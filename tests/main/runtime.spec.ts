import { InMemoryMessageBus } from '@infrastructure/messaging/in-memory-message-bus';
import { SqsSnsMessageBus } from '@infrastructure/messaging/sqs-sns-message-bus';
import { makeMessageBus, makeRuntime } from '@main/factories/runtime';

describe('composition root', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('MESSAGING_DRIVER=memory usa o bus em memória', () => {
    process.env.MESSAGING_DRIVER = 'memory';
    expect(makeMessageBus()).toBeInstanceOf(InMemoryMessageBus);
  });

  it('driver sqs exige as URLs da fila e do tópico', () => {
    delete process.env.MESSAGING_DRIVER;
    delete process.env.EXECUTION_COMMANDS_QUEUE_URL;
    expect(() => makeMessageBus()).toThrow('EXECUTION_COMMANDS_QUEUE_URL');
    process.env.EXECUTION_COMMANDS_QUEUE_URL =
      'http://localhost:4566/000000000000/execution-commands';
    expect(() => makeMessageBus()).toThrow('EVENTS_TOPIC_ARN');
    process.env.EVENTS_TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:oficina-eventos';
    expect(makeMessageBus()).toBeInstanceOf(SqsSnsMessageBus);
  });

  it('makeRuntime monta repositório, controller, handler e relay', () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    const rt = makeRuntime(new InMemoryMessageBus());
    expect(rt.repository).toBeDefined();
    expect(rt.controller).toBeDefined();
    expect(rt.commandHandler).toBeDefined();
    expect(rt.relay).toBeDefined();
  });
});
