import { ExecucaoStatus } from '@domain/entities/execucao.entity';
import { ValidationError } from '@shared/errors/domain.error';
import { ServicoDiagnosticado } from '@shared/messaging/messages';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const textoOpcional = (v: unknown, campo: string, max = 1000): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${campo} deve ser texto`);
  if (v.length > max) throw new ValidationError(`${campo} excede ${max} caracteres`);
  return v;
};

export const validarMotivo = (body: unknown): { motivo: string } => {
  const motivo = isObject(body) ? textoOpcional(body.motivo, 'motivo', 500) : undefined;
  if (!motivo) throw new ValidationError('motivo é obrigatório');
  return { motivo };
};

export const validarObservacoes = (body: unknown): { observacoes?: string } => ({
  observacoes: isObject(body) ? textoOpcional(body.observacoes, 'observacoes') : undefined,
});

export const validarDiagnostico = (
  body: unknown,
): { servicos: ServicoDiagnosticado[]; observacoes?: string } => {
  if (!isObject(body) || !Array.isArray(body.servicos) || body.servicos.length === 0) {
    throw new ValidationError('servicos deve ser uma lista com ao menos um item');
  }
  const servicos = body.servicos.map((s: unknown, i: number): ServicoDiagnosticado => {
    if (!isObject(s) || typeof s.catalogoServicoId !== 'string' || !s.catalogoServicoId) {
      throw new ValidationError(`servicos[${i}].catalogoServicoId é obrigatório`);
    }
    const pecasRaw = s.pecas ?? [];
    if (!Array.isArray(pecasRaw))
      throw new ValidationError(`servicos[${i}].pecas deve ser uma lista`);
    const pecas = pecasRaw.map((p: unknown, j: number) => {
      if (
        !isObject(p) ||
        typeof p.pecaId !== 'string' ||
        !p.pecaId ||
        !Number.isInteger(p.quantidade) ||
        (p.quantidade as number) < 1
      ) {
        throw new ValidationError(
          `servicos[${i}].pecas[${j}] inválida: informe pecaId e quantidade inteira >= 1`,
        );
      }
      return { pecaId: p.pecaId, quantidade: p.quantidade as number };
    });
    return { catalogoServicoId: s.catalogoServicoId, pecas };
  });
  return { servicos, observacoes: textoOpcional(body.observacoes, 'observacoes') };
};

export const validarFilaQuery = (
  query: Record<string, unknown>,
): { status: ExecucaoStatus; limit: number } => {
  const status = (query.status ?? ExecucaoStatus.AGUARDANDO_DIAGNOSTICO) as string;
  if (!Object.values(ExecucaoStatus).includes(status as ExecucaoStatus)) {
    throw new ValidationError(`status inválido. Use: ${Object.values(ExecucaoStatus).join(', ')}`);
  }
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('limit deve ser um inteiro entre 1 e 100');
  }
  return { status: status as ExecucaoStatus, limit };
};
