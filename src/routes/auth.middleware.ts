import { FastifyInstance, FastifyPluginOptions } from 'fastify';

export async function authMiddleware(app: FastifyInstance, _opts: FastifyPluginOptions) {
  app.addHook('preHandler', async (_req, _reply) => {
    // Mock authentication - would verify Microsoft Entra ID JWT here
    return;
  });
}
