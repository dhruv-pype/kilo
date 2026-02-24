/**
 * Error hierarchy for Kilo.
 *
 * Every error has a `code` (machine-readable) and `message` (human-readable).
 * This lets the API layer map errors to appropriate HTTP status codes and
 * lets callers handle specific failure modes without string matching.
 */

export class KiloError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KiloError';
  }
}

// ─── Database Errors ───────────────────────────────────────────

export class DatabaseError extends KiloError {
  constructor(message: string, cause?: unknown) {
    super('DATABASE_ERROR', message, 500, cause);
    this.name = 'DatabaseError';
  }
}

export class SchemaCreationError extends KiloError {
  constructor(schemaName: string, cause?: unknown) {
    super('SCHEMA_CREATION_FAILED', `Failed to create schema: ${schemaName}`, 500, cause);
    this.name = 'SchemaCreationError';
  }
}

// ─── Skill Errors ──────────────────────────────────────────────

export class SkillValidationError extends KiloError {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly errors: { field: string; rule: string; message: string }[],
  ) {
    super('SKILL_VALIDATION_FAILED', message, 400);
    this.name = 'SkillValidationError';
  }
}

export class SkillNotFoundError extends KiloError {
  constructor(skillId: string) {
    super('SKILL_NOT_FOUND', `Skill not found: ${skillId}`, 404);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillLimitExceededError extends KiloError {
  constructor(botId: string, limit: number) {
    super('SKILL_LIMIT_EXCEEDED', `Bot ${botId} has reached the skill limit of ${limit}`, 403);
    this.name = 'SkillLimitExceededError';
  }
}

// ─── LLM Errors ────────────────────────────────────────────────

export class LLMError extends KiloError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    cause?: unknown,
  ) {
    super('LLM_ERROR', message, 502, cause);
    this.name = 'LLMError';
  }
}

export class LLMTimeoutError extends KiloError {
  constructor(provider: string, model: string, timeoutMs: number) {
    super('LLM_TIMEOUT', `LLM timeout after ${timeoutMs}ms (${provider}/${model})`, 504);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMAllProvidersFailedError extends KiloError {
  constructor(taskType: string) {
    super('LLM_ALL_PROVIDERS_FAILED', `All LLM providers failed for task: ${taskType}`, 503);
    this.name = 'LLMAllProvidersFailedError';
  }
}

// ─── Bot Errors ────────────────────────────────────────────────

export class BotNotFoundError extends KiloError {
  constructor(botId: string) {
    super('BOT_NOT_FOUND', `Bot not found: ${botId}`, 404);
    this.name = 'BotNotFoundError';
  }
}

// ─── Auth Errors ───────────────────────────────────────────────

export class AuthenticationError extends KiloError {
  constructor(message: string = 'Authentication required') {
    super('AUTH_REQUIRED', message, 401);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends KiloError {
  constructor(message: string = 'Not authorized') {
    super('NOT_AUTHORIZED', message, 403);
    this.name = 'AuthorizationError';
  }
}

// ─── Usage Errors ─────────────────────────────────────────────

export class UsageTrackingError extends KiloError {
  constructor(message: string, cause?: unknown) {
    super('USAGE_TRACKING_ERROR', message, 500, cause);
    this.name = 'UsageTrackingError';
  }
}

// ─── Cache Errors ──────────────────────────────────────────────

export class CacheError extends KiloError {
  constructor(message: string, cause?: unknown) {
    super('CACHE_ERROR', message, 500, cause);
    this.name = 'CacheError';
  }
}

// ─── Tool Execution Errors ────────────────────────────────────

export class CredentialError extends KiloError {
  constructor(message: string, cause?: unknown) {
    super('CREDENTIAL_ERROR', message, 500, cause);
    this.name = 'CredentialError';
  }
}

export class ToolExecutionError extends KiloError {
  constructor(message: string, public readonly toolName: string, cause?: unknown) {
    super('TOOL_EXECUTION_ERROR', message, 502, cause);
    this.name = 'ToolExecutionError';
  }
}

export class ToolNotFoundError extends KiloError {
  constructor(toolId: string) {
    super('TOOL_NOT_FOUND', `Tool not found: ${toolId}`, 404);
    this.name = 'ToolNotFoundError';
  }
}

// ─── Web Research Errors ─────────────────────────────────────────

export class WebResearchError extends KiloError {
  constructor(message: string, public readonly stage?: string, cause?: unknown) {
    super('WEB_RESEARCH_ERROR', message, 502, cause);
    this.name = 'WebResearchError';
  }
}
