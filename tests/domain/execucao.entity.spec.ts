import { Execucao, ExecucaoStatus as S } from '@domain/entities/execucao.entity';
import { InvalidTransitionError, ValidationError } from '@shared/errors/domain.error';

const nova = (over: Partial<Parameters<typeof Execucao.criar>[0]> = {}): Execucao =>
  Execucao.criar({
    ordemServicoId: 'os-1',
    numeroOS: 'OS-1',
    clienteId: 'c-1',
    veiculoId: 'v-1',
    placa: 'ABC1D23',
    prioridade: 'NORMAL',
    sagaId: 'saga-1',
    ...over,
  });

const servicos = [{ catalogoServicoId: 's-1', pecas: [{ pecaId: 'p-1', quantidade: 2 }] }];

/** Leva uma execução nova até o estado desejado pelo caminho feliz. */
const ate = (alvo: S): Execucao => {
  const e = nova();
  if (alvo === S.AGUARDANDO_DIAGNOSTICO) return e;
  e.iniciarDiagnostico();
  if (alvo === S.EM_DIAGNOSTICO) return e;
  e.concluirDiagnostico(servicos);
  if (alvo === S.DIAGNOSTICADA) return e;
  e.enfileirarReparo();
  if (alvo === S.AGUARDANDO_REPARO) return e;
  e.iniciarReparo();
  if (alvo === S.EM_REPARO) return e;
  e.concluirReparo('ok');
  return e;
};

describe('Execucao', () => {
  describe('criar', () => {
    it('nasce AGUARDANDO_DIAGNOSTICO, versão 0 e prioridade normalizada', () => {
      const e = nova({ prioridade: 'qualquer' as never });
      expect(e.status).toBe(S.AGUARDANDO_DIAGNOSTICO);
      expect(e.versao).toBe(0);
      expect(e.prioridade).toBe('NORMAL');
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(nova({ prioridade: 'ALTA' }).prioridade).toBe('ALTA');
    });

    it.each(['ordemServicoId', 'numeroOS', 'clienteId', 'veiculoId', 'sagaId'])(
      'rejeita sem %s',
      (campo) => {
        expect(() => nova({ [campo]: '' })).toThrow(ValidationError);
      },
    );
  });

  it('caminho feliz percorre todos os estados e guarda dados', () => {
    const e = ate(S.CONCLUIDA);
    expect(e.status).toBe(S.CONCLUIDA);
    expect(e.diagnostico?.servicos).toEqual(servicos);
    expect(e.observacoesReparo).toBe('ok');
    expect(e.terminal).toBe(true);
  });

  it('falha de diagnóstico e de reparo levam a FALHOU com motivo', () => {
    const d = ate(S.EM_DIAGNOSTICO);
    d.falharDiagnostico('sem acesso ao veículo');
    expect(d.status).toBe(S.FALHOU);
    expect(d.motivo).toBe('sem acesso ao veículo');

    const r = ate(S.EM_REPARO);
    r.falharReparo('peça quebrou');
    expect(r.status).toBe(S.FALHOU);
    expect(r.terminal).toBe(true);
  });

  describe('cancelar', () => {
    it.each([
      S.AGUARDANDO_DIAGNOSTICO,
      S.EM_DIAGNOSTICO,
      S.DIAGNOSTICADA,
      S.AGUARDANDO_REPARO,
      S.EM_REPARO,
    ])('cancela a partir de %s', (origem) => {
      const e = ate(origem);
      e.cancelar('cliente desistiu');
      expect(e.status).toBe(S.CANCELADA);
      expect(e.motivo).toBe('cliente desistiu');
    });

    it.each([S.CONCLUIDA, S.CANCELADA])('não cancela a partir de %s', (origem) => {
      const e = ate(S.CONCLUIDA);
      if (origem === S.CANCELADA) {
        const c = nova();
        c.cancelar('x');
        expect(() => c.cancelar('y')).toThrow(InvalidTransitionError);
      } else {
        expect(() => e.cancelar('tarde')).toThrow(InvalidTransitionError);
      }
    });

    it('FALHOU também é terminal', () => {
      const e = ate(S.EM_REPARO);
      e.falharReparo('x');
      expect(() => e.cancelar('y')).toThrow(InvalidTransitionError);
    });
  });

  describe('matriz de transições inválidas', () => {
    const acoes: [string, S[], (e: Execucao) => void][] = [
      ['iniciarDiagnostico', [S.AGUARDANDO_DIAGNOSTICO], (e) => e.iniciarDiagnostico()],
      ['concluirDiagnostico', [S.EM_DIAGNOSTICO], (e) => e.concluirDiagnostico(servicos)],
      ['falharDiagnostico', [S.EM_DIAGNOSTICO], (e) => e.falharDiagnostico('m')],
      ['enfileirarReparo', [S.DIAGNOSTICADA], (e) => e.enfileirarReparo()],
      ['iniciarReparo', [S.AGUARDANDO_REPARO], (e) => e.iniciarReparo()],
      ['concluirReparo', [S.EM_REPARO], (e) => e.concluirReparo()],
      ['falharReparo', [S.EM_REPARO], (e) => e.falharReparo('m')],
    ];
    const estados = [
      S.AGUARDANDO_DIAGNOSTICO,
      S.EM_DIAGNOSTICO,
      S.DIAGNOSTICADA,
      S.AGUARDANDO_REPARO,
      S.EM_REPARO,
      S.CONCLUIDA,
    ];

    for (const [nome, validos, agir] of acoes) {
      for (const estado of estados) {
        const ok = validos.includes(estado);
        it(`${nome} em ${estado} ${ok ? 'é permitida' : 'é rejeitada'}`, () => {
          const e = ate(estado);
          if (ok) expect(() => agir(e)).not.toThrow();
          else expect(() => agir(e)).toThrow(InvalidTransitionError);
        });
      }
    }
  });

  describe('validação do diagnóstico', () => {
    it.each([
      [[], 'ao menos um serviço'],
      [[{ catalogoServicoId: '', pecas: [] }], 'catalogoServicoId'],
      [[{ catalogoServicoId: 's', pecas: [{ pecaId: 'p', quantidade: 0 }] }], 'Peça inválida'],
      [[{ catalogoServicoId: 's', pecas: [{ pecaId: '', quantidade: 1 }] }], 'Peça inválida'],
      [[{ catalogoServicoId: 's', pecas: [{ pecaId: 'p', quantidade: 1.5 }] }], 'Peça inválida'],
    ])('rejeita %j', (lista, msg) => {
      const e = ate(S.EM_DIAGNOSTICO);
      expect(() => e.concluirDiagnostico(lista as never)).toThrow(msg);
      expect(e.status).toBe(S.EM_DIAGNOSTICO);
    });

    it('serviço sem peças é válido (mão de obra pura)', () => {
      const e = ate(S.EM_DIAGNOSTICO);
      e.concluirDiagnostico([{ catalogoServicoId: 's', pecas: [] }]);
      expect(e.status).toBe(S.DIAGNOSTICADA);
    });
  });

  it('restaurar/toProps preservam dados e registrarPersistencia incrementa a versão', () => {
    const e = ate(S.EM_DIAGNOSTICO);
    e.registrarPersistencia();
    const copia = Execucao.restaurar(e.toProps());
    expect(copia.versao).toBe(1);
    expect(copia.status).toBe(S.EM_DIAGNOSTICO);
    expect(copia.placa).toBe('ABC1D23');
    expect(copia.numeroOS).toBe('OS-1');
    expect(copia.clienteId).toBe('c-1');
    expect(copia.veiculoId).toBe('v-1');
    expect(copia.descricaoProblema).toBeUndefined();
    expect(copia.sagaId).toBe('saga-1');
    expect(copia.criadoEm).toBeInstanceOf(Date);
    expect(copia.atualizadoEm).toBeInstanceOf(Date);
  });
});
