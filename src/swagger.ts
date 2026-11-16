const STATUS = [
  'AGUARDANDO_DIAGNOSTICO',
  'EM_DIAGNOSTICO',
  'DIAGNOSTICADA',
  'AGUARDANDO_REPARO',
  'EM_REPARO',
  'CONCLUIDA',
  'FALHOU',
  'CANCELADA',
];

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const security = [{ bearerAuth: [] }];
const respostas = {
  '200': {
    description: 'Execução atualizada',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Execucao' } } },
  },
  '400': { description: 'Dados inválidos' },
  '401': { description: 'Token ausente ou inválido' },
  '403': { description: 'Rota restrita ao escopo interno' },
  '404': { description: 'Execução não encontrada' },
  '422': { description: 'Transição inválida para o estado atual' },
};
const acao = (
  summary: string,
  description: string,
  schema?: string,
  required = false,
): Record<string, unknown> => ({
  patch: {
    tags: ['Execuções'],
    summary,
    description,
    security,
    parameters: [idParam],
    ...(schema
      ? {
          requestBody: {
            required,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
          },
        }
      : {}),
    responses: respostas,
  },
});

export const DOCS_PATH = process.env.DOCS_PATH ?? '/api/execucoes/docs';

export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Execution Service — Oficina',
    description: 'Fila de execução da oficina: diagnóstico e reparo das ordens de serviço.',
    version: '1.0.0',
    contact: { name: 'Tech Challenge SOAT FIAP' },
  },
  servers: [{ url: 'http://localhost:3002', description: 'Desenvolvimento local' }],
  tags: [
    { name: 'Health', description: 'Saúde do serviço' },
    { name: 'Execuções', description: 'Fila de execução: diagnóstico e reparo (escopo interno)' },
  ],
  components: {
    schemas: {
      Execucao: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          ordemServicoId: { type: 'string', format: 'uuid' },
          numeroOS: { type: 'string', example: 'OS-20261111-0007' },
          clienteId: { type: 'string' },
          veiculoId: { type: 'string' },
          placa: { type: 'string', example: 'ABC1D23' },
          descricaoProblema: { type: 'string' },
          prioridade: { type: 'string', enum: ['NORMAL', 'ALTA'] },
          status: { type: 'string', enum: STATUS },
          sagaId: { type: 'string', format: 'uuid' },
          diagnostico: { $ref: '#/components/schemas/Diagnostico' },
          observacoesReparo: { type: 'string' },
          motivo: { type: 'string' },
          versao: { type: 'integer' },
          criadoEm: { type: 'string', format: 'date-time' },
          atualizadoEm: { type: 'string', format: 'date-time' },
        },
      },
      Diagnostico: {
        type: 'object',
        properties: {
          servicos: {
            type: 'array',
            items: {
              type: 'object',
              required: ['catalogoServicoId'],
              properties: {
                catalogoServicoId: { type: 'string', format: 'uuid' },
                pecas: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['pecaId', 'quantidade'],
                    properties: {
                      pecaId: { type: 'string', format: 'uuid' },
                      quantidade: { type: 'integer', minimum: 1 },
                    },
                  },
                },
              },
            },
          },
          observacoes: { type: 'string' },
        },
      },
      Motivo: {
        type: 'object',
        required: ['motivo'],
        properties: { motivo: { type: 'string', maxLength: 500 } },
      },
      Observacoes: {
        type: 'object',
        properties: { observacoes: { type: 'string', maxLength: 1000 } },
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT assinado com o JWT_SECRET compartilhado (RFC-003): `scope: interno` (usuários da oficina) ou `scope: cliente` (emitido pela Lambda de CPF).',
      },
    },
  },
  paths: {
    '/api/execucoes/fila': {
      get: {
        tags: ['Execuções'],
        summary: 'Fila de execução',
        description:
          'Execuções de um status, ordenadas por prioridade (ALTA primeiro) e ordem de chegada. Use `AGUARDANDO_DIAGNOSTICO` ou `AGUARDANDO_REPARO` para as filas de trabalho.',
        security,
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: STATUS, default: 'AGUARDANDO_DIAGNOSTICO' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Lista de execuções',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'success' },
                    data: { type: 'array', items: { $ref: '#/components/schemas/Execucao' } },
                  },
                },
              },
            },
          },
          '400': { description: 'Filtro inválido' },
          '401': { description: 'Token ausente ou inválido' },
          '403': { description: 'Rota restrita ao escopo interno' },
        },
      },
    },
    '/api/execucoes/{id}': {
      get: {
        tags: ['Execuções'],
        summary: 'Execução com histórico de etapas',
        security,
        parameters: [idParam],
        responses: {
          '200': {
            description: 'Execução + `historico[]` (evento, status anterior/novo, autor, instante)',
          },
          '401': { description: 'Token ausente ou inválido' },
          '403': { description: 'Rota restrita ao escopo interno' },
          '404': { description: 'Execução não encontrada' },
        },
      },
    },
    '/api/execucoes/{id}/diagnostico/iniciar': acao(
      'Mecânico inicia o diagnóstico',
      'AGUARDANDO_DIAGNOSTICO → EM_DIAGNOSTICO.',
    ),
    '/api/execucoes/{id}/diagnostico/concluir': acao(
      'Conclui o diagnóstico',
      'EM_DIAGNOSTICO → DIAGNOSTICADA. Informa serviços (do catálogo) e peças necessárias; a precificação é do OS Service. Publica `DiagnosticoConcluido`.',
      'Diagnostico',
      true,
    ),
    '/api/execucoes/{id}/diagnostico/falhar': acao(
      'Reporta falha no diagnóstico',
      'EM_DIAGNOSTICO → FALHOU. Publica `DiagnosticoFalhou` (a Saga compensa e cancela a OS).',
      'Motivo',
      true,
    ),
    '/api/execucoes/{id}/reparo/iniciar': acao(
      'Mecânico inicia o reparo',
      'AGUARDANDO_REPARO (após o comando `IniciarReparo` do OS) → EM_REPARO.',
    ),
    '/api/execucoes/{id}/reparo/concluir': acao(
      'Conclui o reparo',
      'EM_REPARO → CONCLUIDA. Publica `ReparoConcluido` (o OS finaliza a OS e dá a baixa definitiva do estoque).',
      'Observacoes',
    ),
    '/api/execucoes/{id}/reparo/falhar': acao(
      'Reporta falha no reparo',
      'EM_REPARO → FALHOU. Publica `ReparoFalhou` (dispara a compensação completa, incluindo estorno).',
      'Motivo',
      true,
    ),
    '/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness — o processo está vivo',
        responses: { '200': { description: 'UP' } },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness — dependências alcançáveis',
        responses: { '200': { description: 'UP' }, '503': { description: 'DOWN' } },
      },
    },
  },
};

export const swaggerUiOptions = {
  customSiteTitle: 'Execution Service — API Docs',
};
