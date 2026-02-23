import type { FastifyInstance } from 'fastify';
import { KiloError } from '../../common/errors/index.js';

/**
 * Global error handler.
 * Maps KiloError subclasses to appropriate HTTP responses.
 * Unknown errors return 500 with a generic message (no internal details leaked).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof KiloError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }

    // Unknown error — log full details, return generic message
    console.error('Unhandled error:', error);
    reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  });
}
