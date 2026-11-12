import { OutboxRelay } from '@application/messaging/outbox-relay';
import { InMemoryMessageBus } from '@infrastructure/messaging/in-memory-message-bus';
import { createEnvelope } from '@shared/messaging/envelope';
import { Destinations } from '@shared/messaging/messages';
import { FakeExecucaoRepository } from '../../support/fake-repositories';

const msg = () =>
  createEnvelope({
    type: 'DiagnosticoIniciado',
    sagaId: 's',
    correlationId: 'c',
    payload: { ordemServicoId: 'o' },
  });

describe('OutboxRelay', () => {
  it('publica pendentes no tópico de eventos e marca como publicadas', async () => {
    const repo = new FakeExecucaoRepository();
    const bus = new InMemoryMessageBus();
    await repo.commit({ mensagens: [msg(), msg()] });

    const publicadas = await new OutboxRelay(repo, bus).tick();

    expect(publicadas).toBe(2);
    expect(bus.sent.map((s) => [s.kind, s.destination])).toEqual([
      ['publish', Destinations.EventosTopic],
      ['publish', Destinations.EventosTopic],
    ]);
    expect(repo.outbox.every((o) => o.publicada)).toBe(true);
    expect(await new OutboxRelay(repo, bus).tick()).toBe(0);
  });

  it('falha ao publicar agenda nova tentativa com backoff e segue para a próxima', async () => {
    const repo = new FakeExecucaoRepository();
    const bus = new InMemoryMessageBus();
    await repo.commit({ mensagens: [msg(), msg()] });
    const publish = jest.spyOn(bus, 'publish').mockRejectedValueOnce(new Error('sns fora'));
    const markFailed = jest.spyOn(repo, 'markFailed');
    const agora = new Date('2026-11-12T10:00:00Z');

    const publicadas = await new OutboxRelay(repo, bus, {}, () => agora).tick();

    expect(publicadas).toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(markFailed).toHaveBeenCalledWith(
      repo.outbox[0].id,
      'sns fora',
      new Date('2026-11-12T10:00:01Z'),
    );
    expect(repo.outbox[0].publicada).toBe(false);
    expect(repo.outbox[1].publicada).toBe(true);
  });

  it('o backoff cresce exponencialmente até o teto', async () => {
    const repo = new FakeExecucaoRepository();
    const bus = new InMemoryMessageBus();
    await repo.commit({ mensagens: [msg()] });
    repo.outbox[0].tentativas = 10;
    jest.spyOn(bus, 'publish').mockRejectedValue('erro cru');
    const markFailed = jest.spyOn(repo, 'markFailed');
    const agora = new Date('2026-11-12T10:00:00Z');

    await new OutboxRelay(repo, bus, { maxBackoffMs: 5000 }, () => agora).tick();

    expect(markFailed).toHaveBeenCalledWith(
      repo.outbox[0].id,
      'erro cru',
      new Date('2026-11-12T10:00:05Z'),
    );
  });

  it('start/stop controlam o laço periódico', async () => {
    jest.useFakeTimers();
    try {
      const repo = new FakeExecucaoRepository();
      const bus = new InMemoryMessageBus();
      await repo.commit({ mensagens: [msg()] });
      const relay = new OutboxRelay(repo, bus, { intervalMs: 100 });
      relay.start();
      await jest.advanceTimersByTimeAsync(150);
      expect(repo.outbox[0].publicada).toBe(true);
      await relay.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
