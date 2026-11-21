export class FactoryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'FactoryError';
  }
}

export class ConfigError extends FactoryError {
  constructor(message: string) {
    super(message, 'CONFIG', 2);
    this.name = 'ConfigError';
  }
}

export class BudgetExceededError extends FactoryError {
  constructor(message: string) {
    super(message, 'BUDGET', 3);
    this.name = 'BudgetExceededError';
  }
}

export class PolicyViolationError extends FactoryError {
  constructor(message: string) {
    super(message, 'POLICY', 4);
    this.name = 'PolicyViolationError';
  }
}

export class LlmError extends FactoryError {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message, 'LLM', 5);
    this.name = 'LlmError';
  }
}
