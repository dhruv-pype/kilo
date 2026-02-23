import type { BotId, UserId } from './ids.js';
import type { SoulDefinition } from './soul.js';

export interface BotConfig {
  botId: BotId;
  userId: UserId;
  name: string;
  description: string;
  personality: string;
  context: string;                  // business details, user preferences, etc.
  soul: SoulDefinition | null;     // structured personality — preferred over flat personality/context
  schemaName: string;              // Postgres schema namespace: "bot_<prefix>"
  createdAt: Date;
  updatedAt: Date;
}

export interface BotCreateInput {
  userId: UserId;
  name: string;
  description: string;
  personality: string;
  context: string;
  soul?: SoulDefinition | null;
}
