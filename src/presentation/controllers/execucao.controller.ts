import { NextFunction, Response } from 'express';
import { ExecucaoUseCases } from '@application/use-cases/execucao.use-cases';
import { Execucao } from '@domain/entities/execucao.entity';
import { HistoricoEvento } from '@domain/repositories/execucao.repository';
import { AuthenticatedRequest } from '@presentation/middlewares/auth.middleware';
import {
  validarDiagnostico,
  validarFilaQuery,
  validarMotivo,
  validarObservacoes,
} from '@presentation/validators/execucao.validator';

const view = (e: Execucao): ReturnType<Execucao['toProps']> => e.toProps();

type Params = { id: string };
type Req = AuthenticatedRequest & { params: Params };

export class ExecucaoController {
  constructor(private readonly useCases: ExecucaoUseCases) {}

  private autor = (req: AuthenticatedRequest): string => req.userId ?? 'interno';

  private handle =
    (fn: (req: Req) => Promise<unknown>, status = 200) =>
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.status(status).json({ status: 'success', data: await fn(req as Req) });
      } catch (error) {
        next(error);
      }
    };

  fila = this.handle(async (req) => {
    const { status, limit } = validarFilaQuery(req.query);
    return (await this.useCases.listarFila(status, limit)).map(view);
  });

  obter = this.handle(async (req) => {
    const { execucao, historico } = await this.useCases.obter(req.params.id);
    return { ...view(execucao), historico: historico.map((h: HistoricoEvento) => h) };
  });

  iniciarDiagnostico = this.handle(async (req) =>
    view(await this.useCases.iniciarDiagnostico(req.params.id, this.autor(req))),
  );

  concluirDiagnostico = this.handle(async (req) =>
    view(
      await this.useCases.concluirDiagnostico(
        req.params.id,
        this.autor(req),
        validarDiagnostico(req.body),
      ),
    ),
  );

  falharDiagnostico = this.handle(async (req) =>
    view(
      await this.useCases.falharDiagnostico(
        req.params.id,
        this.autor(req),
        validarMotivo(req.body).motivo,
      ),
    ),
  );

  iniciarReparo = this.handle(async (req) =>
    view(await this.useCases.iniciarReparo(req.params.id, this.autor(req))),
  );

  concluirReparo = this.handle(async (req) =>
    view(
      await this.useCases.concluirReparo(
        req.params.id,
        this.autor(req),
        validarObservacoes(req.body).observacoes,
      ),
    ),
  );

  falharReparo = this.handle(async (req) =>
    view(
      await this.useCases.falharReparo(
        req.params.id,
        this.autor(req),
        validarMotivo(req.body).motivo,
      ),
    ),
  );
}
