# Tabela única do Execution Service (ADR-011). Modelo de chaves: src/infrastructure/database/dynamodb/keys.ts
#
#  gsi1: fila de execução      (gsi1pk = STATUS#<status>,  gsi1sk = <prio>#<criadoEm>#<id>)
#  gsi2: execução por OS       (gsi2pk = OS#<ordemServicoId>)
#  gsi3: outbox pendente       (índice esparso: só existe enquanto gsi3pk estiver presente)
resource "aws_dynamodb_table" "execucoes" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST" # on-demand: sem capacidade para dimensionar nem pagar parado
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }
  attribute {
    name = "gsi3pk"
    type = "S"
  }
  attribute {
    name = "gsi3sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }
  global_secondary_index {
    name            = "gsi3"
    hash_key        = "gsi3pk"
    range_key       = "gsi3sk"
    projection_type = "ALL"
  }

  # Expira inbox (idempotência) e outbox já publicado.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}
