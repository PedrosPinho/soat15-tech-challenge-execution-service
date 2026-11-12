import { Router } from 'express';
import { ExecucaoController } from '@presentation/controllers/execucao.controller';
import { authMiddleware, requireInternalScope } from '@presentation/middlewares/auth.middleware';

/** Todas as rotas são do escopo `interno` (mecânicos/atendentes da oficina). */
export const createExecucaoRouter = (controller: ExecucaoController): Router => {
  const router = Router();
  router.use(authMiddleware, requireInternalScope);

  router.get('/fila', controller.fila);
  router.get('/:id', controller.obter);
  router.patch('/:id/diagnostico/iniciar', controller.iniciarDiagnostico);
  router.patch('/:id/diagnostico/concluir', controller.concluirDiagnostico);
  router.patch('/:id/diagnostico/falhar', controller.falharDiagnostico);
  router.patch('/:id/reparo/iniciar', controller.iniciarReparo);
  router.patch('/:id/reparo/concluir', controller.concluirReparo);
  router.patch('/:id/reparo/falhar', controller.falharReparo);
  return router;
};
