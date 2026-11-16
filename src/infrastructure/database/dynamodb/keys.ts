import { ExecucaoStatus } from '@domain/entities/execucao.entity';
import { Prioridade } from '@shared/messaging/messages';

/**
 * Modelo single-table da tabela `execucoes` (ADR-011). Convenção de chaves:
 *
 *  entidade   PK                 SK                    GSI1 (fila)                         GSI2 (por OS)    GSI3 (outbox pendente)
 *  Execução   EXEC#<id>          META                  STATUS#<status> / <prio>#<criado>   OS#<osId> / EXEC —
 *  Histórico  EXEC#<id>          EVT#<ts>#<rand>       —                                   —                —
 *  Trava OS   OSLOCK#<osId>      META                  —                                   —                —   (1 execução por OS)
 *  Outbox     OUTBOX#<msgId>     META                  —                                   —                OUTBOX#PENDING / <ts>#<msgId>
 *  Inbox      INBOX#<msgId>      META                  —                                   —                —   (TTL)
 */
export const INDEX_FILA = 'gsi1';
export const INDEX_OS = 'gsi2';
export const INDEX_OUTBOX = 'gsi3';

export const META = 'META';
export const OUTBOX_PENDENTE = 'OUTBOX#PENDING';

export const pkExecucao = (id: string): string => `EXEC#${id}`;
export const pkTravaOs = (osId: string): string => `OSLOCK#${osId}`;
export const pkOutbox = (messageId: string): string => `OUTBOX#${messageId}`;
export const pkInbox = (messageId: string): string => `INBOX#${messageId}`;
export const skEvento = (iso: string, rand: string): string => `EVT#${iso}#${rand}`;
export const gsi1pk = (status: ExecucaoStatus): string => `STATUS#${status}`;
export const gsi2pk = (osId: string): string => `OS#${osId}`;

/** ALTA (0) sai antes de NORMAL (1); dentro da prioridade, ordem de chegada. */
export const gsi1sk = (prioridade: Prioridade, criadoEm: Date, id: string): string =>
  `${prioridade === 'ALTA' ? 0 : 1}#${criadoEm.toISOString()}#${id}`;

export const INBOX_TTL_SEGUNDOS = 7 * 24 * 3600;
export const OUTBOX_PUBLICADO_TTL_SEGUNDOS = 7 * 24 * 3600;
