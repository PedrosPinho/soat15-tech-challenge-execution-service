# Execution Service — Oficina Mecânica

Fila de execução da oficina: diagnóstico e reparo das ordens de serviço. Um dos **três microsserviços** da Fase 4 do Tech Challenge SOAT
(FIAP Pós-Tech), ao lado do OS Service
([`soat15-tech-challenge-01`](https://github.com/PedrosPinho/soat15-tech-challenge-01),
orquestrador da Saga) e do Billing Service.

> **Status**: Etapa 3 do [`PHASE_4_PLAN`](https://github.com/PedrosPinho/soat15-tech-challenge-01/blob/main/docs/PHASE_4_PLAN.md) concluída —
> domínio, repositório DynamoDB, outbox/inbox, consumidor de comandos, API do mecânico, Terraform, K8s e CI.
> Pendente de validação em ambiente com Docker/AWS: o spec de integração com LocalStack e o `terraform apply`.

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

## Ciclo da execução

```
AGUARDANDO_DIAGNOSTICO → EM_DIAGNOSTICO → DIAGNOSTICADA → AGUARDANDO_REPARO → EM_REPARO → CONCLUIDA
                              └──────────────────────────────────────────────┴──→ FALHOU
  CANCELADA (a partir de qualquer estado não terminal, por CancelarExecucao)
```

- `SolicitarDiagnostico` cria a execução na fila (prioridade `ALTA` antes de `NORMAL`, depois ordem de chegada) e responde `DiagnosticoIniciado`.
- O mecânico inicia/conclui o diagnóstico pela API; `DiagnosticoConcluido` leva os serviços (do catálogo) e as peças — a **precificação é do OS Service**.
- `IniciarReparo` (após aprovação e pagamento) move para `AGUARDANDO_REPARO` e responde `ReparoIniciado`; o mecânico então inicia e conclui/falha o reparo (`ReparoConcluido` / `ReparoFalhou`).
- `CancelarExecucao` é compensação idempotente: responde `ExecucaoCancelada` mesmo se a execução não existir ou já for terminal.

## Endpoints

| Método | Rota | Escopo | Descrição |
|---|---|---|---|
| GET | `/api/execucoes/fila` | interno | Próximas execuções da fila |
| GET | `/api/execucoes/:id` | interno | Execução + histórico |
| PATCH | `/api/execucoes/:id/diagnostico/iniciar` | interno | Mecânico inicia o diagnóstico |
| PATCH | `/api/execucoes/:id/diagnostico/concluir` | interno | Conclui, informando serviços/peças necessários |
| PATCH | `/api/execucoes/:id/diagnostico/falhar` | interno | Reporta falha no diagnóstico (`DiagnosticoFalhou`) |
| PATCH | `/api/execucoes/:id/reparo/iniciar` | interno | Inicia o reparo |
| PATCH | `/api/execucoes/:id/reparo/concluir` | interno | Conclui o reparo |
| PATCH | `/api/execucoes/:id/reparo/falhar` | interno | Reporta falha (dispara a compensação da Saga) |

Swagger em `/api/execucoes/docs` (JSON em `/api/execucoes/docs.json`). Healthchecks: `GET /health/live`, `GET /health/ready`.

## Confiabilidade (DynamoDB)

Toda gravação é uma única `TransactWriteItems` com: estado da execução (lock otimista por `versao`),
histórico (`EVT#<ts>`), mensagens do **outbox** e o item do **inbox** (`INBOX#<messageId>`, TTL de 7 dias).
Logo, "mudou o estado mas não registrou o evento" não existe, e um comando repetido é descartado de forma atômica.
O relay lê o outbox por um índice esparso (GSI3), reivindica cada item com um *lease* condicional
(equivalente ao `SKIP LOCKED` do Postgres — 2 réplicas não publicam a mesma mensagem) e publica no SNS
com backoff exponencial. Uma trava `OSLOCK#<osId>` garante uma execução por OS mesmo com comandos concorrentes.
Modelo de chaves: [`keys.ts`](src/infrastructure/database/dynamodb/keys.ts).

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
docker compose up -d localstack            # SQS, SNS e DynamoDB locais (cria tabela, fila e tópico)
npm ci
npm run dev                                # http://localhost:3001
```

Subir tudo (LocalStack + API, porta 3002): `docker compose up --build`. Modos: `MESSAGING_DRIVER=memory` roda sem AWS; `MESSAGING_ENABLED=false` roda só a API.

Testes: `npm test` · cobertura: `npm run test:coverage` (threshold 80%) · lint: `npm run lint` · tipos: `npm run type-check`.

## Qualidade, CI/CD e cobertura

- CI em GitHub Actions (`.github/workflows/ci-cd.yml`): `Build` (tipos, lint, build), `Test` (cobertura com threshold de 80%) e `Sonar` (SonarCloud; o passo espera o quality gate). Em PR roda também `Terraform plan`; em push (`homolog`) `terraform apply` → build/push no ECR → deploy.
- Jobs de infraestrutura: `terraform-validate` (fmt + validate), `terraform-apply` (ECR, tabela, fila + DLQ; `apply` só em `homolog`, `plan` em `main` — ADR-007), `docker-build-push` (ECR) e `deploy` (EKS). SonarCloud entra na Etapa 8.
- `tests/integration-localstack.spec.ts` roda contra DynamoDB/SQS/SNS reais (service container do LocalStack no CI; localmente defina `LOCALSTACK_ENDPOINT=http://localhost:4566`).
- Infra do serviço em [`terraform/`](terraform) (estado remoto S3, workspaces `homolog`/`prod`) e manifests em [`k8s/`](k8s). Requer o `apply` prévio do OS Service (dono do tópico `oficina-eventos`).
- Evidência de cobertura: _a preencher_ (badge SonarCloud + relatório do CI).
- `main` e `homolog` protegidas: PR obrigatório e status checks `Build`, `Test` e `Sonar` (`scripts/protect-branches.sh` no repo do OS Service aplica). `destroy.yml` (manual) remove workloads e infra do serviço.

## Documentação da arquitetura

Documentação geral (diagrama de componentes, Saga, ADRs, RFCs, modelo de dados) no
repositório [`soat15-tech-challenge-01`](https://github.com/PedrosPinho/soat15-tech-challenge-01/tree/main/docs/architecture).
