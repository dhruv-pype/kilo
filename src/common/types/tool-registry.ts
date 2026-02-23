/**
 * Tool Registry types — Phase 2.
 *
 * Each bot can register external API integrations (Canva, Stripe, etc.).
 * Credentials are encrypted at rest via the credential vault.
 * The orchestrator loads tools at runtime to enable `call_api` tool calls.
 */

import type { BotId, ToolRegistryId } from './ids.js';

// ─── Auth Types ─────────────────────────────────────────────────

export type AuthType = 'api_key' | 'bearer' | 'oauth2' | 'custom_header';

/**
 * Encrypted payload produced by the credential vault.
 * All fields are hex-encoded strings. Never log these values.
 */
export interface EncryptedPayload {
  iv: string;         // 12-byte IV, hex
  authTag: string;    // 16-byte GCM auth tag, hex
  ciphertext: string; // hex-encoded ciphertext
}

/**
 * Auth configuration as stored in the database (encrypted JSONB).
 * The plaintext shape varies by authType:
 *   api_key:       { key: string; headerName?: string }
 *   bearer:        { token: string }
 *   oauth2:        { clientId: string; clientSecret: string; tokenUrl: string; accessToken?: string }
 *   custom_header: { headerName: string; headerValue: string }
 */
export interface AuthConfig {
  encrypted: EncryptedPayload;
}

// ─── Tool Endpoint ──────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ToolEndpoint {
  path: string;                                    // e.g. "/v1/designs"
  method: HttpMethod;
  description: string;
  parameters: Record<string, unknown>;             // JSON Schema for request body/query
  responseSchema: Record<string, unknown> | null;  // Expected response shape (optional)
}

// ─── Tool Registry Entry ────────────────────────────────────────

export interface ToolRegistryEntry {
  toolId: ToolRegistryId;
  botId: BotId;
  name: string;               // e.g. "canva", "stripe"
  description: string;
  baseUrl: string;            // e.g. "https://api.canva.com"
  authType: AuthType;
  authConfig: AuthConfig;     // encrypted at rest — only the orchestrator decrypts
  endpoints: ToolEndpoint[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Redacted view returned by API GET endpoints — authConfig is stripped.
 * Never send raw authConfig over the wire.
 */
export interface ToolRegistryEntryRedacted {
  toolId: ToolRegistryId;
  botId: BotId;
  name: string;
  description: string;
  baseUrl: string;
  authType: AuthType;
  endpoints: ToolEndpoint[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Create / Update Inputs ─────────────────────────────────────

export interface ToolRegistryCreateInput {
  botId: BotId;
  name: string;
  description: string;
  baseUrl: string;
  authType: AuthType;
  authConfigPlaintext: string;  // raw JSON — will be encrypted before storage
  endpoints: ToolEndpoint[];
}

export interface ToolRegistryUpdateInput {
  name?: string;
  description?: string;
  baseUrl?: string;
  authType?: AuthType;
  authConfigPlaintext?: string; // if provided, re-encrypted before storage
  endpoints?: ToolEndpoint[];
  isActive?: boolean;
}

// ─── HTTP Executor Types ────────────────────────────────────────

export interface HttpToolRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: unknown | null;
  timeoutMs: number;  // default 10_000
}

export interface HttpToolResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;       // parsed JSON or string
  truncated: boolean;
}
