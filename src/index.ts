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

  // JWT auth — required for multi-user API security
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET must be set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  }
  if (process.env.NODE_ENV === 'production' && jwtSecret === 'change-me-in-production') {
    throw new Error('JWT_SECRET must be changed from the default value in production.');
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
    jwtSecret,
  };

  const { app, scheduler } = await createServer(config);

  await app.listen({ port: config.port, host: config.host });
  console.log(`Kilo server running on ${config.host}:${config.port}`);

  // Initialize scheduler after server is ready
  await scheduler.initialize();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[shutdown] Stopping scheduler...');
    scheduler.stopAll();
    console.log('[shutdown] Closing server...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
