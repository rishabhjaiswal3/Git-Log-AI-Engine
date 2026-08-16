export class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404, 'NOT_FOUND');
  }
}

export class SchemaValidationError extends AppError {
  constructor(message) {
    super(message, 422, 'SCHEMA_VALIDATION_ERROR');
  }
}

export class RateLimitError extends AppError {
  constructor(message, retryAfterSeconds) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UpstreamError extends AppError {
  constructor(message) {
    super(message, 502, 'UPSTREAM_ERROR');
  }
}
