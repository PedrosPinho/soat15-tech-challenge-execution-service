#!/bin/bash
# Cria no LocalStack a mesma topologia de terraform/ (tabela, fila de comandos + DLQ) e a do
# OS Service que este serviço usa (tópico oficina-eventos e fila de respostas), para testar o
# fluxo sem AWS. Executado automaticamente pelo LocalStack no estado "ready" (docker-compose.yml).
set -euo pipefail

REGION=us-east-1

awslocal dynamodb create-table --table-name execucoes --billing-mode PAY_PER_REQUEST --region "$REGION" \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    AttributeName=gsi1pk,AttributeType=S AttributeName=gsi1sk,AttributeType=S \
    AttributeName=gsi2pk,AttributeType=S AttributeName=gsi2sk,AttributeType=S \
    AttributeName=gsi3pk,AttributeType=S AttributeName=gsi3sk,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    '[{"IndexName":"gsi1","KeySchema":[{"AttributeName":"gsi1pk","KeyType":"HASH"},{"AttributeName":"gsi1sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"gsi2","KeySchema":[{"AttributeName":"gsi2pk","KeyType":"HASH"},{"AttributeName":"gsi2sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"gsi3","KeySchema":[{"AttributeName":"gsi3pk","KeyType":"HASH"},{"AttributeName":"gsi3sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' >/dev/null
awslocal dynamodb update-time-to-live --table-name execucoes --region "$REGION" \
  --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null

create_queue_with_dlq() {
  local name="$1"
  awslocal sqs create-queue --queue-name "${name}-dlq" --region "$REGION" >/dev/null
  local dlq_arn
  dlq_arn=$(awslocal sqs get-queue-attributes --queue-url "http://localhost:4566/000000000000/${name}-dlq" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)
  awslocal sqs create-queue --queue-name "$name" --region "$REGION" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\",\"ReceiveMessageWaitTimeSeconds\":\"20\"}" >/dev/null
}

awslocal sns create-topic --name oficina-eventos --region "$REGION" >/dev/null
create_queue_with_dlq execution-commands

echo "LocalStack: tabela execucoes, fila execution-commands e tópico oficina-eventos criados"
