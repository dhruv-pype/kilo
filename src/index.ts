import dotenv from 'dotenv';
import { createServer } from './api/server.js';

dotenv.config();

async function main() {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasAnthropic && !hasOpenAI) {
    throw new Error('Missing LLM provider key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.warn('[startup] BRAVE_SEARCH_API_KEY not set: web research/auto-learning will be unavailable.');
  }

  const credentialKey = process.env.KILO_CREDENTIAL_KEY;
  if (!credentialKey) {
    console.warn('[startup] KILO_CREDENTIAL_KEY not set: tool credential encryption and API tool setup will fail.');
  } else if (!/^[a-fA-F0-9]{64}$/.test(credentialKey)) {
    console.warn('[startup] KILO_CREDENTIAL_KEY is invalid: expected a 64-character hex string.');
  }

  const parsedPort = parseInt(process.env.PORT ?? '3000', 10);
  if (Number.isNaN(parsedPort) || parsedPort <= 0) {
    throw new Error('Invalid PORT. Provide a positive integer value.');
  }

  const config = {
    port: parsedPort,
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://kilo:kilo@localhost:5432/kilo',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  };

  const server = await createServer(config);

  await server.listen({ port: config.port, host: config.host });
  console.log(`Kilo server running on ${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
