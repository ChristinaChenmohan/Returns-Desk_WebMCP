export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly recoveryAction?: string,
    readonly currentState?: string,
  ) {
    super(code);
  }
}
