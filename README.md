# Execution Service — Oficina Mecânica

Fila de execução da oficina: diagnóstico e reparo das ordens de serviço. Um dos **três microsserviços** da Fase 4 do Tech Challenge SOAT
(FIAP Pós-Tech), ao lado do OS Service
([`soat15-tech-challenge-01`](https://github.com/PedrosPinho/soat15-tech-challenge-01),
orquestrador da Saga) e do Billing Service.

> **Status**: esqueleto (Etapa 1 do [`PHASE_4_PLAN`](https://github.com/PedrosPinho/soat15-tech-challenge-01/blob/main/docs/PHASE_4_PLAN.md)).
> Estão prontos: estrutura DDD, healthchecks, logs com `correlationId`, Swagger,
> Docker, CI (build + testes com cobertura ≥ 80%). Regras de negócio e mensageria entram nas Etapas 3 em diante.

## Responsabilidades

- **Fila de execução**: receber `SolicitarDiagnostico` e enfileirar a execução por prioridade/ordem de chegada.
- **Diagnóstico e reparo**: o mecânico inicia/conclui/falha cada etapa; o serviço registra o histórico.
- **Comunicar** ao OS Service (por eventos) o início, a conclusão ou a falha de cada etapa.

## Banco de dados

**Amazon DynamoDB** (NoSQL) — tabela única `execucoes` on-demand: estado atual, histórico de etapas e a fila por GSI ([ADR-011](https://github.com/PedrosPinho/soat15-tech-challenge-01/blob/main/docs/architecture/adrs/ADR-011-dynamodb-no-execution-service.md)). O acesso é sempre por chave (`execucaoId`, `ordemServicoId`, próximos da fila), sem joins.

Nenhum outro serviço acessa este banco diretamente — dados trafegam por
mensagens e pelas rotas `/internal/*`.

## Comunicação

- **Consome**: `SolicitarDiagnostico`, `IniciarReparo`, `CancelarExecucao` (fila `execution-commands`)
- **Publica**: `DiagnosticoIniciado`, `DiagnosticoConcluido`, `DiagnosticoFalhou`, `ReparoIniciado`, `ReparoConcluido`, `ReparoFalhou`, `ExecucaoCancelada` (tópico SNS `oficina-eventos`)
- Contratos, envelope e regras de consumo (idempotência, DLQ): [`contratos-mensagens.md`](https://github.com/PedrosPinho/soat15-tech-challenge-01/blob/main/docs/architecture/contratos-mensagens.md)
- Saga **orquestrada** pelo OS Service — justificativa em [`ADR-009`](https://github.com/PedrosPinho/soat15-tech-challenge-01/blob/main/docs/architecture/adrs/ADR-009-saga-orquestrada.md) e [`RFC-005`](https://github.com/PedrosPinho/soat15-tech-challenge-01/blob/main/docs/architecture/rfcs/RFC-005-microsservicos-e-saga.md). Este serviço não conhece o fluxo global: recebe comandos e responde com eventos.

## Endpoints (planejados)

| Método | Rota | Escopo | Descrição |
|---|---|---|---|
| GET | `/api/execucoes/fila` | interno | Próximas execuções da fila |
| GET | `/api/execucoes/:id` | interno | Execução + histórico |
| PATCH | `/api/execucoes/:id/diagnostico/iniciar` | interno | Mecânico inicia o diagnóstico |
| PATCH | `/api/execucoes/:id/diagnostico/concluir` | interno | Conclui, informando serviços/peças necessários |
| PATCH | `/api/execucoes/:id/reparo/iniciar` | interno | Inicia o reparo |
| PATCH | `/api/execucoes/:id/reparo/concluir` | interno | Conclui o reparo |
| PATCH | `/api/execucoes/:id/reparo/falhar` | interno | Reporta falha (dispara a compensação da Saga) |

Swagger em `/api/execucoes/docs` (JSON em `/api/execucoes/docs.json`). Healthchecks: `GET /health/live`, `GET /health/ready`.

## Arquitetura do serviço

```
src/
├── domain/           # Entidades, value objects, ports (repositórios, mensageria)
├── application/      # Casos de uso, handlers de comandos
├── infrastructure/   # Adapters: banco, SQS/SNS, segurança, notificações
├── presentation/     # Controllers, rotas, middlewares, validators
├── main/             # Composition root
└── shared/           # Erros de domínio, logger (pino + correlationId)
```

## Stack

Node.js 20 · TypeScript (strict) · Express 5 · DynamoDB (AWS SDK v3) · SQS/SNS · pino · Jest + Supertest · New Relic · Docker · Kubernetes (EKS)

## Executando localmente

```bash
cp .env.example .env
docker compose up -d localstack            # SQS, SNS e DynamoDB locais
npm ci
npm run dev                                # http://localhost:3001
```

Testes: `npm test` · cobertura: `npm run test:coverage` (threshold 80%) · lint: `npm run lint` · tipos: `npm run type-check`.

## Qualidade, CI/CD e cobertura

- CI em GitHub Actions (`.github/workflows/ci-cd.yml`): `Build` (tipos, lint, build) e `Test` (cobertura com threshold de 80%).
- Etapa 8: SonarCloud com quality gate, Terraform do serviço, build/push no ECR e deploy no EKS.
- Evidência de cobertura: _a preencher_ (badge SonarCloud + relatório do CI).
- `main` e `homolog` protegidas: PR obrigatório e status checks `Build` e `Test`.

## Documentação da arquitetura

Documentação geral (diagrama de componentes, Saga, ADRs, RFCs, modelo de dados) no
repositório [`soat15-tech-challenge-01`](https://github.com/PedrosPinho/soat15-tech-challenge-01/tree/main/docs/architecture).
