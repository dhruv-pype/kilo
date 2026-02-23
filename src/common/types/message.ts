import type { BotId, MessageId, SessionId, UserId } from './ids.js';

export type MessageRole = 'user' | 'assistant' | 'system';

export type AttachmentType = 'image' | 'document' | 'voice';

export interface Attachment {
  type: AttachmentType;
  url: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

export interface UserMessage {
  messageId: MessageId;
  sessionId: SessionId;
  botId: BotId;
  userId: UserId;
  content: string;
  attachments: Attachment[];
  timestamp: Date;
}

export interface AssistantMessage {
  messageId: MessageId;
  sessionId: SessionId;
  botId: BotId;
  content: string;
  role: 'assistant';
  skillId: string | null;  // which skill handled this, if any
  timestamp: Date;
}

export interface Message {
  messageId: MessageId;
  sessionId: SessionId;
  botId: BotId;
  role: MessageRole;
  content: string;
  attachments: Attachment[];
  skillId: string | null;
  timestamp: Date;
}
