output "ecr_repository_url" {
  description = "URL do repositório ECR do Execution Service"
  value       = aws_ecr_repository.execution_service.repository_url
}

output "dynamodb_table_name" {
  description = "Tabela única do Execution Service"
  value       = aws_dynamodb_table.execucoes.name
}

output "execution_commands_queue_url" {
  description = "URL da fila execution-commands (consumida por este serviço; o OS envia)"
  value       = aws_sqs_queue.execution_commands.url
}

output "execution_commands_queue_arn" {
  description = "ARN da fila execution-commands"
  value       = aws_sqs_queue.execution_commands.arn
}

output "execution_commands_dlq_url" {
  description = "URL da DLQ de execution-commands"
  value       = aws_sqs_queue.execution_commands_dlq.url
}

output "events_topic_arn" {
  description = "ARN do tópico oficina-eventos (do OS Service), onde este serviço publica"
  value       = data.terraform_remote_state.os.outputs.events_topic_arn
}
