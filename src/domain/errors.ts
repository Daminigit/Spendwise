/**
 * src/domain/errors.ts
 *
 * A typed error for business-rule failures. Web routes and MCP tools map
 * `kind` to an HTTP status / tool error; anything that is NOT a DomainError
 * is treated as an unexpected server error and its message is never shown.
 */

export type DomainErrorKind = 'not_found' | 'forbidden' | 'invalid' | 'conflict';

export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(message: string, kind?: DomainErrorKind) {
    super(message);
    this.name = 'DomainError';
    this.kind = kind ?? inferKind(message);
  }
}

/** Best-effort classification so existing messages don't all need a kind. */
function inferKind(message: string): DomainErrorKind {
  const m = message.toLowerCase();
  if (m.includes('not found')) return 'not_found';
  if (
    m.includes('permission') ||
    m.includes('cannot access') ||
    m.includes('only admins') ||
    m.includes('employees cannot') ||
    m.includes('do not own') ||
    m.includes('only approve')
  ) {
    return 'forbidden';
  }
  return 'invalid';
}

export function httpStatusFor(err: DomainError): number {
  switch (err.kind) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'conflict':
      return 409;
    default:
      return 400;
  }
}
