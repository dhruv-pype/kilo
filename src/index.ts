import dotenv from 'dotenv';
import { createServer } from './api/server.js';

dotenv.config();

async function main() {
  const config = {
    port: parseInt(process.env.PORT ?? '3000', 10),
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
