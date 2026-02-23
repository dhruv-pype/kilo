import type { SkillDefinition } from './skill.js';
import type { ToolCall } from './orchestrator.js';

export type ValidationStage = 'schema' | 'trigger_overlap' | 'dry_run' | 'user_confirmation';

export interface ValidationResult {
  passed: boolean;
  stage: ValidationStage;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  autoFixApplied: boolean;
  autoFixDescription: string | null;
  conflicts: TriggerConflict[];
  dryRunResults: DryRunResult[];
}

export interface ValidationError {
  field: string;
  rule: string;
  message: string;
  autoFixable: boolean;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface TriggerConflict {
  newPattern: string;
  existingSkill: SkillDefinition;
  existingPattern: string;
  similarity: number;
  resolutionOptions: TriggerResolution[];
}

export type TriggerResolution = 'keep_both' | 'merge' | 'replace';

export interface DryRunResult {
  testMessage: string;
  response: string;
  toolCalls: ToolCall[];
  checks: DryRunCheck[];
}

export interface DryRunCheck {
  name: string;
  passed: boolean;
  detail: string;
}
