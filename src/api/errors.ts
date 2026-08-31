export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryable = false, readonly recoveryAction?: string) { super(message); }
}
