export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends DomainError {}
export class ValidationError extends DomainError {}
export class ConflictError extends DomainError {}
export class UnauthorizedError extends DomainError {}
export class ForbiddenError extends DomainError {}

/** Transição de estado inválida para o estado atual do agregado. */
export class InvalidTransitionError extends DomainError {}
/** Lock otimista: outro processo alterou o agregado entre a leitura e a gravação. */
export class ConcurrencyError extends ConflictError {}
/** Mensagem já processada (inbox) — o consumidor confirma sem reprocessar. */
export class DuplicateMessageError extends DomainError {}
/** Mensagem inválida de forma permanente (tipo/versão/payload) — vai para a DLQ. */
export class InvalidMessageError extends DomainError {}
