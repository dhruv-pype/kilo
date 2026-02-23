# Spec #3: Full Skill Validation Pipeline

## Decision
Every skill passes through a 4-stage validation pipeline before activation: Schema Validation → Trigger Overlap Detection → Dry-Run Test → User "Try It" Step. No skill goes live without passing all stages.

## Problem Being Solved
The PRD says skills are "stored in the cloud and immediately active" after the LLM generates them. This means a bad LLM output (invalid schema, overly broad triggers, contradictory behavior prompt) goes live immediately and damages user trust. The risk matrix acknowledges this but offers no concrete mitigation.

## Design

### 1. Pipeline Overview

```
User approves skill concept
        │
        ▼
┌─────────────────────┐
│  Stage 1: Schema    │ ── FAIL ──▶ Auto-fix attempt (1 retry) ──▶ FAIL ──▶ Apologize, ask user to rephrase
│  Validation         │
└────────┬────────────┘
         │ PASS
         ▼
┌─────────────────────┐
│  Stage 2: Trigger   │ ── CONFLICT ──▶ Show user which skills conflict, ask to resolve
│  Overlap Detection  │
└────────┬────────────┘
         │ PASS
         ▼
┌─────────────────────┐
│  Stage 3: Dry-Run   │ ── FAIL ──▶ Auto-fix attempt (1 retry) ──▶ FAIL ──▶ Apologize, ask user to rephrase
│  Test               │
└────────┬────────────┘
         │ PASS
         ▼
┌─────────────────────┐
│  Stage 4: User      │ ── User rejects ──▶ Ask what's wrong, refine, restart from Stage 1
│  "Try It" Step      │
└────────┬────────────┘
         │ User confirms
         ▼
    Skill activated
```

**Total added latency**: ~2-5 seconds for stages 1-3 (automated). Stage 4 requires user interaction but is part of the conversation flow, not a blocking wait.

### 2. Stage 1: Schema Validation

Validates the structural correctness of the generated Skill Definition Object.

#### Checks

| Check | Rule | Failure Action |
|---|---|---|
| `name` | Non-empty, ≤ 100 chars, no special chars except spaces/hyphens | Auto-fix: truncate/sanitize |
| `trigger_patterns` | Non-empty array, each pattern ≤ 200 chars, at least 2 patterns | Auto-fix: generate additional patterns from skill description |
| `behavior_prompt` | Non-empty, ≤ 5000 chars, contains no prompt injection patterns | Reject if injection detected; auto-fix if too long (summarize) |
| `input_schema` | Valid JSON Schema draft-07, ≤ 30 properties, all types are mappable (see Spec #1) | Auto-fix: correct common schema errors (missing type, invalid format) |
| `output_format` | One of: `text`, `structured_card`, `notification`, `action` | Auto-fix: default to `text` |
| `schedule` | If present, valid cron expression. No interval < 15 minutes. | Reject schedules < 15min (prevent spam). Auto-fix common cron errors. |
| `data_table` name | Valid SQL identifier, ≤ 63 chars, no reserved words | Auto-fix: sanitize |

#### Prompt Injection Detection

The `behavior_prompt` is scanned for patterns that could manipulate the LLM:
- "Ignore previous instructions"
- "You are now..."
- "Forget your system prompt"
- Encoded/obfuscated text (base64, unicode tricks)

This is a defense-in-depth measure. The LLM is the primary generator of behavior prompts, so injection is unlikely in the normal flow — but a compromised or adversarial input could reach here.

#### Auto-Fix Strategy

On first failure, the system attempts a single auto-fix:
1. Send the Skill Definition Object + validation errors to the LLM
2. Ask it to fix the specific errors while preserving the user's intent
3. Re-validate the fixed version
4. If it still fails: apologize to the user and ask them to rephrase their request

One retry, not infinite loops. If the LLM can't produce a valid skill in 2 attempts, the request is genuinely ambiguous and the user needs to provide more clarity.

### 3. Stage 2: Trigger Overlap Detection

Detects when a new skill's trigger patterns would conflict with existing skills.

#### Algorithm

```
For each trigger_pattern in new_skill:
  For each existing_skill in bot.skills:
    For each existing_pattern in existing_skill.trigger_patterns:
      similarity = compute_similarity(trigger_pattern, existing_pattern)
      IF similarity > OVERLAP_THRESHOLD:
        conflicts.add({ new_pattern, existing_skill, existing_pattern, similarity })
```

**Similarity computation**: Two-phase, mirroring SkillMatcher (Spec #2):
1. **Keyword overlap**: Jaccard similarity on tokenized words. Threshold: 0.7
2. **Semantic similarity**: Embedding cosine similarity (using the same embedding model as the Knowledge Store). Threshold: 0.85

#### Conflict Resolution

If conflicts are detected, the user sees:

```
"Your new 'Weekly Sales Report' skill might overlap with your existing
'Daily Sales Log' skill. Both respond to messages about sales data.

Options:
1. Keep both — I'll ask you which one to use when it's ambiguous
2. Merge them — I'll add the weekly report feature to your existing Daily Sales Log
3. Replace — Delete Daily Sales Log and use Weekly Sales Report instead"
```

This maps to the PRD's UX philosophy of explaining things in plain English and letting the user decide.

### 4. Stage 3: Dry-Run Test

Validates that the skill actually works by running a synthetic interaction.

#### Process

1. **Generate synthetic input**: Using the skill's `trigger_patterns` and `input_schema`, generate 2-3 realistic test messages. Example for Order Tracker: "New order: test customer, chocolate cake, 2-tier, pickup tomorrow"

2. **Execute the skill pipeline**: Run the full Orchestrator flow (Spec #2) with the test message, but with these modifications:
   - Data writes go to a temporary table (not the real skill table)
   - Notifications are logged but not sent
   - The response is captured for validation

3. **Validate the output**:

| Check | Rule |
|---|---|
| Response not empty | The LLM produced a response |
| Response matches output_format | If `structured_card`, response contains structured data. If `text`, response is natural language. |
| Tool calls are valid | If the LLM called `insert_skill_data`, the data matches the `input_schema` |
| No hallucinated fields | The LLM didn't invent data fields not in the schema |
| Response is relevant | Basic semantic check: response is about the same topic as the skill |
| Response length reasonable | Not a single word, not a 2000-word essay for a simple log entry |

4. **Cleanup**: Drop the temporary table.

#### Auto-Fix Strategy

Same as Stage 1: one retry with the LLM, sending the validation errors and asking it to fix the behavior prompt. If it still fails, ask the user to rephrase.

### 5. Stage 4: User "Try It" Step

The final gate before activation. The user sends a real test message and sees the result.

#### UX Flow

```
Bot: "Your Order Tracker is almost ready! Let's test it.
      Try telling me about a sample order — you can use made-up info."

User: "New order: Test person, vanilla cupcakes, dozen, pickup Friday"

Bot: "Here's how I'd handle that:

      ✅ Logged Order #TEST-1
      Customer: Test person
      Item: vanilla cupcakes (dozen)
      Pickup: Friday

      I'd also remind you Thursday evening to confirm.

      Does this look right? Say 'activate' to make it live,
      or tell me what to change."
```

**Key behaviors**:
- Test data is stored in a temporary table and **discarded** after activation (unless the user says "keep this as a real order")
- The user can iterate: "Actually, also capture the price" → triggers a skill refinement → back to Stage 1
- "Activate" or equivalent affirmation → skill goes live
- The user can also say "never mind" → skill is discarded entirely

#### When to Skip Stage 4

Stage 4 is **optional** for:
- Skills that don't store data (e.g., a simple "draft an Instagram caption" skill)
- Skills seeded during onboarding (the Builder Bot's starter skills are pre-validated)
- Skills enhanced (not created) — e.g., adding a field to an existing skill

For these cases, stages 1-3 still run, but the user sees a simpler confirmation: "I've updated your Order Tracker to also capture prices. All set!"

### 6. Validation Result Object

```typescript
interface ValidationResult {
  passed: boolean;
  stage: 'schema' | 'trigger_overlap' | 'dry_run' | 'user_confirmation';
  errors: ValidationError[];
  warnings: ValidationWarning[];     // non-blocking issues
  autoFixApplied: boolean;
  autoFixDescription?: string;
  conflicts?: TriggerConflict[];     // only for stage 2
  dryRunResults?: DryRunResult[];    // only for stage 3
}

interface ValidationError {
  field: string;          // which field failed
  rule: string;           // which check
  message: string;        // human-readable explanation
  autoFixable: boolean;
}

interface TriggerConflict {
  newPattern: string;
  existingSkill: SkillDefinition;
  existingPattern: string;
  similarity: number;
  resolutionOptions: ('keep_both' | 'merge' | 'replace')[];
}

interface DryRunResult {
  testMessage: string;
  response: string;
  toolCalls: ToolCall[];
  checks: { name: string; passed: boolean; detail: string }[];
}
```

### 7. Performance Budget

The validation pipeline runs between user approval ("Yes, create that skill") and the "Try It" step. Users expect some processing time here — they just asked the bot to learn something new. But it shouldn't feel slow.

| Stage | Target Latency | Notes |
|---|---|---|
| Schema Validation | < 50ms | Pure computation, no I/O |
| Trigger Overlap | < 200ms | Embedding similarity requires vector computation |
| Dry-Run Test | < 3s | Includes one LLM round trip |
| **Total (automated)** | **< 3.5s** | User sees "Setting up your new skill..." |

If the auto-fix retry fires, add another ~2s. The user sees "Almost there, let me adjust something..." during this time. Honest, conversational status messages.

### 8. What This Does NOT Cover

- **Runtime skill monitoring**: This spec covers pre-activation validation. Post-activation quality monitoring (the `performance_score` field) is a separate concern. The score should be fed back into the Skill Proposer to improve future proposals.
- **Skill versioning validation**: When a skill is refined (not created), the validation pipeline runs on the diff, not the full skill. The rules for what counts as a "breaking change" (e.g., removing a required field) are not specified here.
- **Malicious skill detection**: The prompt injection check in Stage 1 is a basic pattern match. A more sophisticated adversarial testing framework is out of scope for v1.
