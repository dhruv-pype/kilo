/**
 * Branded ID types prevent accidentally passing a bot_id where a skill_id is expected.
 * TypeScript's structural typing means `string` is `string` everywhere — branded types
 * add a compile-time tag so the compiler rejects mismatched IDs.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type BotId = Brand<string, 'BotId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type UsageId = Brand<string, 'UsageId'>;
export type ToolRegistryId = Brand<string, 'ToolRegistryId'>;

export function userId(id: string): UserId {
  return id as UserId;
}

export function botId(id: string): BotId {
  return id as BotId;
}

export function skillId(id: string): SkillId {
  return id as SkillId;
}

export function sessionId(id: string): SessionId {
  return id as SessionId;
}

export function messageId(id: string): MessageId {
  return id as MessageId;
}

export function usageId(id: string): UsageId {
  return id as UsageId;
}

export function toolRegistryId(id: string): ToolRegistryId {
  return id as ToolRegistryId;
}
