import Fastify from 'fastify';
import fastifySSE from 'fastify-sse-v2';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { authMiddleware } from './routes/auth.middleware.js';
import { chatRoutes } from './routes/chat.route.js';
import { automationRoutes } from './routes/automation.route.js';
import { directAIWebSocketRoutes } from './routes/direct-ai-websocket.route.js';

export function buildApp() {
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' },
  });

  // CORS for extension and local dev
  app.register(cors, {
    origin: [/^chrome-extension:\/\//, /http:\/\/localhost(:\d+)?$/],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // WebSocket support
  app.register(websocket);

  // Register shared JSON Schemas for $ref usage
  app.addSchema({
    $id: 'Conversation',
    type: 'object',
    properties: {
      _id: { type: 'string' },
      userId: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string' },
      lastMsgAt: { type: 'string', format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  });
  app.addSchema({
    $id: 'Message',
    type: 'object',
    properties: {
      _id: { type: 'string' },
      convId: { type: 'string' },
      userId: { type: 'string' },
      sender: { type: 'string', enum: ['user', 'assistant'] },
      content: {
        type: 'array',
        items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } } },
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  });
  app.addSchema({
    $id: 'AutomationStep',
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['click', 'type', 'assert', 'wait', 'scroll', 'select', 'hover'] },
      selector: { type: 'string' },
      text: { type: 'string' },
      value: { type: 'string' },
      timeout: { type: 'number' },
      description: { type: 'string' },
    },
  });
  app.addSchema({
    $id: 'AutomationScript',
    type: 'object',
    properties: {
      _id: { type: 'string' },
      convId: { type: 'string' },
      userId: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      steps: { type: 'array', items: { $ref: 'AutomationStep#' } },
      status: { type: 'string', enum: ['draft', 'ready', 'running', 'completed', 'failed'] },
      result: { type: 'object', additionalProperties: true },
      error: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  });

  // Request log
  app.addHook('onRequest', async (request, _reply) => {
    request.log.info({ method: request.method, url: request.url }, 'incoming request');
  });

  // Health
  app.get('/health', {
    schema: {
      tags: ['system'],
      summary: 'Health check',
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  }, async () => ({ ok: true }));

  // Swagger
  app.register(swagger, {
    openapi: {
      info: { title: 'Corp Extension API', version: '0.1.0', description: 'Backend for corp extension: conversations, messages, actions, SSE.' },
      servers: [{ url: '/' }],
      tags: [
        { name: 'system', description: 'System endpoints' },
        { name: 'chat', description: 'Conversations and messages' },
        { name: 'automation', description: 'Automation scripts' },
      ],
      components: {
        schemas: {
          Conversation: { $ref: 'Conversation#' },
          Message: { $ref: 'Message#' },
          AutomationScript: { $ref: 'AutomationScript#' },
          AutomationStep: { $ref: 'AutomationStep#' },
        },
      },
    },
  });
  app.register(swaggerUI, { routePrefix: '/docs' });

  // SSE plugin
  app.register(fastifySSE as any);

  // Auth middleware (placeholder)
  app.register(authMiddleware);

  // Routes
  app.register(chatRoutes, { prefix: '/api' });
  app.register(automationRoutes, { prefix: '/api' });
  app.register(directAIWebSocketRoutes, { prefix: '/api' });

  // Error handler
  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error);
    reply.code((error as any).statusCode ?? 500).send({ message: error.message ?? 'Internal Server Error' });
  });

  return app;
}
