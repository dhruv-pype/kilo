/**
 * JWT authentication middleware for Fastify.
 *
 * Registers @fastify/jwt and adds an onRequest hook that:
 * 1. Skips /health and non-/api/ routes
 * 2. Verifies the JWT from the Authorization header
 * 3. Sets request.userId (branded UserId)
 * 4. Sets the AsyncLocalStorage request context for RLS
 *
 * The CLI (npm run chat) never goes through HTTP and is unaffected.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { userId } from '../../common/types/ids.js';
import type { UserId } from '../../common/types/ids.js';
import { AuthenticationError } from '../../common/errors/index.js';
import { requestContext } from '../../database/request-context.js';

// ─── Fastify type augmentation ───────────────────────────────
declare module 'fastify' {
  interface FastifyRequest {
    userId: UserId;
  }
}

// ─── JWT payload shape ───────────────────────────────────────
interface JWTPayload {
  sub: string; // userId
  iat: number;
  exp: number;
}

// ─── Registration ────────────────────────────────────────────

export async function registerAuth(app: FastifyInstance, jwtSecret: string): Promise<void> {
  await app.register(fastifyJwt, { secret: jwtSecret });

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    // Skip auth for non-API routes
    if (request.url === '/health') return;
    if (!request.url.startsWith('/api/')) return;

    try {
      const decoded = await request.jwtVerify<JWTPayload>();
      request.userId = userId(decoded.sub);

      // Set the database request context for Row-Level Security.
      // enterWith() propagates through the entire async chain for this request.
      requestContext.enterWith({ userId: decoded.sub });
    } catch (_err) {
      throw new AuthenticationError('Invalid or expired token');
    }
  });
}
