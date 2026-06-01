export class AppError extends Error {
  public readonly code: number;
  public readonly details?: unknown;

  constructor(params: { message: string; code: number; details?: unknown }) {
    super(params.message);
    this.code = params.code;
    this.details = params.details;
    Error.captureStackTrace(this, this.constructor);
  }
}
