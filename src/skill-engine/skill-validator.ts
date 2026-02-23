import type { SkillDefinition, SkillCreateInput } from '../common/types/skill.js';
import type {
  ValidationResult,
  ValidationError,
  ValidationWarning,
  TriggerConflict,
  DryRunResult,
} from '../common/types/validation.js';

/**
 * Skill Validation Pipeline — Spec #3 implementation.
 *
 * 4 stages, run in order. Each stage can pass, fail, or require user input.
 * Stages 1-3 are automated. Stage 4 (user "Try It") is handled by the API layer.
 *
 * Stage 1: Schema Validation — structural correctness
 * Stage 2: Trigger Overlap Detection — conflicts with existing skills
 * Stage 3: Dry-Run Test — execute a synthetic interaction (requires LLM, deferred)
 * Stage 4: User Confirmation — handled in API/chat layer
 */

// ─── Stage 1: Schema Validation ────────────────────────────────

const MAX_NAME_LENGTH = 100;
const MAX_TRIGGER_PATTERN_LENGTH = 200;
const MIN_TRIGGER_PATTERNS = 2;
const MAX_BEHAVIOR_PROMPT_LENGTH = 5000;
const MAX_INPUT_SCHEMA_PROPERTIES = 30;
const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

/**
 * Prompt injection patterns to detect in behavior prompts.
 * Defense-in-depth: the LLM generates these prompts, so injection is
 * unlikely in normal flow, but compromised input could reach here.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+(instructions|prompts|rules)/i,
  /you\s+are\s+now\b/i,
  /forget\s+(your|the)\s+(system|original)\s+(prompt|instructions)/i,
  /disregard\s+(all|any|previous)\s+(instructions|rules)/i,
  /override\s+(system|safety)\s+(prompt|rules|filters)/i,
];

export function validateSchema(input: SkillCreateInput): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Name checks
  if (!input.name || input.name.trim().length === 0) {
    errors.push({ field: 'name', rule: 'required', message: 'Skill name is required', autoFixable: true });
  } else if (input.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: 'name', rule: 'max_length', message: `Name must be ≤ ${MAX_NAME_LENGTH} chars`, autoFixable: true });
  }

  // Trigger patterns
  if (!input.triggerPatterns || input.triggerPatterns.length < MIN_TRIGGER_PATTERNS) {
    errors.push({
      field: 'triggerPatterns',
      rule: 'min_count',
      message: `At least ${MIN_TRIGGER_PATTERNS} trigger patterns required`,
      autoFixable: true,
    });
  } else {
    for (const pattern of input.triggerPatterns) {
      if (pattern.length > MAX_TRIGGER_PATTERN_LENGTH) {
        errors.push({
          field: 'triggerPatterns',
          rule: 'max_length',
          message: `Trigger pattern too long: "${pattern.slice(0, 50)}..."`,
          autoFixable: true,
        });
      }
    }
  }

  // Behavior prompt
  if (!input.behaviorPrompt || input.behaviorPrompt.trim().length === 0) {
    errors.push({ field: 'behaviorPrompt', rule: 'required', message: 'Behavior prompt is required', autoFixable: false });
  } else if (input.behaviorPrompt.length > MAX_BEHAVIOR_PROMPT_LENGTH) {
    errors.push({
      field: 'behaviorPrompt',
      rule: 'max_length',
      message: `Behavior prompt must be ≤ ${MAX_BEHAVIOR_PROMPT_LENGTH} chars`,
      autoFixable: true,
    });
  }

  // Prompt injection detection
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input.behaviorPrompt ?? '')) {
      errors.push({
        field: 'behaviorPrompt',
        rule: 'injection_detected',
        message: 'Behavior prompt contains potentially harmful instructions',
        autoFixable: false,
      });
      break; // One injection error is enough
    }
  }

  // Input schema
  if (input.inputSchema) {
    const properties = input.inputSchema.properties as Record<string, unknown> | undefined;
    if (properties && Object.keys(properties).length > MAX_INPUT_SCHEMA_PROPERTIES) {
      errors.push({
        field: 'inputSchema',
        rule: 'max_properties',
        message: `Input schema has too many properties (max ${MAX_INPUT_SCHEMA_PROPERTIES})`,
        autoFixable: false,
      });
    }

    // Validate each property has a type
    if (properties) {
      for (const [propName, propSchema] of Object.entries(properties)) {
        const schema = propSchema as Record<string, unknown>;
        if (!schema.type) {
          errors.push({
            field: `inputSchema.properties.${propName}`,
            rule: 'missing_type',
            message: `Property "${propName}" is missing a type`,
            autoFixable: true,
          });
        }
      }
    }
  }

  // Output format
  const validFormats = ['text', 'structured_card', 'notification', 'action'];
  if (!validFormats.includes(input.outputFormat)) {
    errors.push({
      field: 'outputFormat',
      rule: 'invalid_value',
      message: `Output format must be one of: ${validFormats.join(', ')}`,
      autoFixable: true,
    });
  }

  // Schedule validation
  if (input.schedule) {
    const scheduleValid = validateCronExpression(input.schedule);
    if (!scheduleValid.valid) {
      errors.push({
        field: 'schedule',
        rule: 'invalid_cron',
        message: `Invalid cron expression: ${scheduleValid.reason}`,
        autoFixable: false,
      });
    } else if (scheduleValid.intervalMinutes !== null && scheduleValid.intervalMinutes < MIN_SCHEDULE_INTERVAL_MINUTES) {
      errors.push({
        field: 'schedule',
        rule: 'too_frequent',
        message: `Schedule fires too frequently (every ${scheduleValid.intervalMinutes} min). Minimum is ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes.`,
        autoFixable: false,
      });
    }
  }

  // Warnings (non-blocking)
  if (input.triggerPatterns && input.triggerPatterns.length < 3) {
    warnings.push({
      field: 'triggerPatterns',
      message: 'Consider adding more trigger patterns for better matching accuracy',
    });
  }

  if (input.behaviorPrompt && input.behaviorPrompt.length < 50) {
    warnings.push({
      field: 'behaviorPrompt',
      message: 'Behavior prompt is very short. A more detailed prompt usually produces better results.',
    });
  }

  return {
    passed: errors.length === 0,
    stage: 'schema',
    errors,
    warnings,
    autoFixApplied: false,
    autoFixDescription: null,
    conflicts: [],
    dryRunResults: [],
  };
}

// ─── Stage 2: Trigger Overlap Detection ────────────────────────

const KEYWORD_OVERLAP_THRESHOLD = 0.7;

/**
 * Detect trigger pattern conflicts between a new skill and existing skills.
 * Uses keyword-based Jaccard similarity (fast, no LLM needed).
 *
 * Semantic similarity via embeddings (Spec #3 mentions this) is deferred
 * to when we have the embedding infrastructure in place.
 */
export function detectTriggerOverlaps(
  newPatterns: string[],
  existingSkills: SkillDefinition[],
): TriggerConflict[] {
  const conflicts: TriggerConflict[] = [];

  for (const newPattern of newPatterns) {
    const newTokens = tokenize(newPattern);

    for (const existing of existingSkills) {
      for (const existingPattern of existing.triggerPatterns) {
        const existingTokens = tokenize(existingPattern);
        const similarity = jaccardSimilarity(newTokens, existingTokens);

        if (similarity >= KEYWORD_OVERLAP_THRESHOLD) {
          conflicts.push({
            newPattern,
            existingSkill: existing,
            existingPattern,
            similarity,
            resolutionOptions: ['keep_both', 'merge', 'replace'],
          });
        }
      }
    }
  }

  return conflicts;
}

export function validateTriggerOverlaps(
  newPatterns: string[],
  existingSkills: SkillDefinition[],
): ValidationResult {
  const conflicts = detectTriggerOverlaps(newPatterns, existingSkills);

  return {
    passed: conflicts.length === 0,
    stage: 'trigger_overlap',
    errors: conflicts.map((c) => ({
      field: 'triggerPatterns',
      rule: 'overlap',
      message: `Pattern "${c.newPattern}" overlaps with "${c.existingSkill.name}" pattern "${c.existingPattern}" (${Math.round(c.similarity * 100)}% similar)`,
      autoFixable: false,
    })),
    warnings: [],
    autoFixApplied: false,
    autoFixDescription: null,
    conflicts,
    dryRunResults: [],
  };
}

// ─── Full Validation Pipeline (Stages 1-2) ─────────────────────

/**
 * Run automated validation stages (1 and 2).
 * Stage 3 (dry-run) requires the LLM Gateway and is handled separately.
 * Stage 4 (user confirmation) is handled in the API layer.
 */
export function validateSkill(
  input: SkillCreateInput,
  existingSkills: SkillDefinition[],
): ValidationResult {
  // Stage 1: Schema validation
  const schemaResult = validateSchema(input);
  if (!schemaResult.passed) {
    return schemaResult;
  }

  // Stage 2: Trigger overlap detection
  const overlapResult = validateTriggerOverlaps(input.triggerPatterns, existingSkills);
  if (!overlapResult.passed) {
    // Merge warnings from stage 1
    overlapResult.warnings.push(...schemaResult.warnings);
    return overlapResult;
  }

  // Both stages passed
  return {
    passed: true,
    stage: 'trigger_overlap', // furthest stage reached
    errors: [],
    warnings: [...schemaResult.warnings, ...overlapResult.warnings],
    autoFixApplied: false,
    autoFixDescription: null,
    conflicts: [],
    dryRunResults: [],
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2), // skip tiny words like "a", "to", "my"
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface CronValidation {
  valid: boolean;
  reason?: string;
  intervalMinutes: number | null;
}

/**
 * Basic cron expression validation.
 * Supports standard 5-field cron: minute hour day month weekday
 */
function validateCronExpression(cron: string): CronValidation {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, reason: 'Cron must have exactly 5 fields', intervalMinutes: null };
  }

  const [minute, hour] = parts;

  // Estimate interval for frequency check
  let intervalMinutes: number | null = null;

  if (minute === '*' && hour === '*') {
    intervalMinutes = 1; // Every minute — too frequent
  } else if (minute.includes('/')) {
    const divisor = parseInt(minute.split('/')[1], 10);
    if (!isNaN(divisor)) {
      intervalMinutes = hour === '*' ? divisor : divisor; // */5 * = every 5 min
    }
  } else if (minute !== '*' && hour === '*') {
    intervalMinutes = 60; // Specific minute every hour
  } else if (minute !== '*' && hour !== '*') {
    intervalMinutes = 24 * 60; // Specific minute and hour = daily
  }

  // Basic field validation
  for (const part of parts) {
    if (!/^[\d*,\-/]+$/.test(part)) {
      return { valid: false, reason: `Invalid cron field: "${part}"`, intervalMinutes: null };
    }
  }

  return { valid: true, intervalMinutes };
}
