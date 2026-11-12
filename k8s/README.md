# Manifests Kubernetes — Execution Service

Namespaces `oficina-homolog` (branch `homolog`) e `oficina-prod` (branch `main`), no EKS
compartilhado de `soat15-tech-challenge-k8s-infra`. O CI troca `namespace: oficina` e
`oficina-ENV` por ambiente.

| Arquivo | Recurso |
|---|---|
| `deployment.yaml` | 1 réplica (HPA 1–2); probes `/health/live` e `/health/ready` (esta consulta o DynamoDB) |
| `service.yaml` | `ClusterIP` na porta 3002 |
| `hpa.yaml` | CPU 70 %, 1–2 réplicas |
| `ingress.yaml` | ALB interno compartilhado (`group oficina-<env>`), path `/api/execucoes` |
| `configmap.yaml` | Configuração estática |
| `secret.example.yaml` | Chaves esperadas do Secret (o real é montado pelo CI) |

`execution-service-messaging` (ConfigMap) **não é versionado**: o CI o cria com
`DYNAMODB_TABLE`, `EXECUTION_COMMANDS_QUEUE_URL` e `EVENTS_TOPIC_ARN`, a partir das saídas do Terraform.

## Permissões AWS

Sem IRSA (IAM bloqueado no Learner Lab): os pods herdam a `LabRole` do node via instance profile
para DynamoDB, SQS e SNS. Se o SDK não alcançar o IMDS de dentro do pod, aumente o
`HttpPutResponseHopLimit` dos nós para 2.

## Teste local

`docker compose up` sobe o LocalStack (DynamoDB, SQS, SNS) e a API — ver README da raiz.
