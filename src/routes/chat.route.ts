import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { MessageSchema } from '../schemas/chat.schema.js';
import { createConversation, listConversations, createMessage, listMessages, listLastMessages, updateConversationWorkflow } from '../services/chat.service.js';
import { AzureOpenAI } from 'openai';

export async function chatRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
  app.post('/conversations', {
    schema: {
      tags: ['chat'],
      summary: 'Create conversation',
      body: { type: 'object', properties: { userId: { type: 'string' }, title: { type: 'string' } }, required: ['userId'] },
      response: { 
        201: { $ref: 'Conversation#' },
        400: { type: 'object', properties: { message: { type: 'string' }, errors: { type: 'object' } } }
      },
    },
  }, async (req, reply) => {
    const body = z.object({ userId: z.string(), title: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: 'Invalid body', errors: body.error.format() });
    const conv = await createConversation(body.data.userId, body.data.title);
    return reply.code(201).send(conv);
  });

  app.get('/conversations', {
    schema: {
      tags: ['chat'],
      summary: 'List conversations by user',
      querystring: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
      response: { 
        200: { type: 'array', items: { $ref: 'Conversation#' } },
        400: { type: 'object', properties: { message: { type: 'string' }, errors: { type: 'object' } } }
      },
    },
  }, async (req, reply) => {
    const query = z.object({ userId: z.string() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ message: 'Invalid query', errors: query.error.format() });
    const list = await listConversations(query.data.userId);
    return reply.send(list);
  });

  app.get('/messages', {
    schema: {
      tags: ['chat'],
      summary: 'List messages in a conversation',
      querystring: { type: 'object', properties: { convId: { type: 'string' } }, required: ['convId'] },
      response: { 
        200: { type: 'array', items: { $ref: 'Message#' } },
        400: { type: 'object', properties: { message: { type: 'string' }, errors: { type: 'object' } } }
      },
    },
  }, async (req, reply) => {
    const query = z.object({ convId: z.string() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ message: 'Invalid query', errors: query.error.format() });
    const list = await listMessages(query.data.convId);
    return reply.send(list);
  });

  // Save user message only (no AI call here)
  app.post('/messages', {
    schema: {
      tags: ['chat'],
      summary: 'Create message (user/assistant)',
      body: {
        type: 'object',
        properties: {
          convId: { type: 'string' },
          userId: { type: 'string' },
          sender: { type: 'string', enum: ['user', 'assistant'] },
          content: {
            type: 'array',
            items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } } },
          },
        },
        required: ['convId', 'userId', 'sender', 'content'],
      },
      response: { 
        201: { $ref: 'Message#' },
        400: { type: 'object', properties: { message: { type: 'string' }, errors: { type: 'object' } } }
      },
    },
  }, async (req, reply) => {
    const bodyParsed = MessageSchema.omit({ _id: true, createdAt: true }).safeParse(req.body);
    if (!bodyParsed.success) return reply.code(400).send({ message: 'Invalid body', errors: bodyParsed.error.format() });

    const msg = await createMessage(bodyParsed.data);
    return reply.code(201).send(msg);
  });

  // SSE: stream assistant reply using last 5 turns (~10 messages)
  app.get('/stream', {
    schema: {
      tags: ['chat'],
      summary: 'Stream assistant reply for a conversation (SSE)',
      querystring: { type: 'object', properties: { convId: { type: 'string' }, userId: { type: 'string' } }, required: ['convId', 'userId'] },
    },
  }, async (req, reply) => {
    const query = z.object({ convId: z.string(), userId: z.string() }).safeParse(req.query);
    if (!query.success) {
      reply.code(400).send({ message: 'Invalid query', errors: query.error.format() });
      return;
    }

    const { convId, userId } = query.data;

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
    const modelName = process.env.AZURE_OPENAI_MODEL || 'gpt-4.1-mini';
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1-mini';
    const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-04-01-preview';

    if (!endpoint || !apiKey) {
      reply.sse({ data: 'Server missing Azure OpenAI configuration' });
      return;
    }

    const lastMessages = await listLastMessages(convId, 10);
    const mapped = lastMessages.map((m) => ({
      role: m.sender === 'assistant' ? 'assistant' as const : 'user' as const,
      content: (m.content || []).filter(c => c.type === 'text').map(c => c.text).join(' '),
    }));

    const client = new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion } as any);

    let full = '';
    try {
      const stream = await client.chat.completions.create({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          ...mapped,
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 2048,
        temperature: 0.7,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        model: modelName,
      } as any);

      for await (const part of stream as any) {
        const delta = part?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          reply.sse({ data: delta });
        }
        // forward usage when present
        if (part?.usage) {
          reply.sse({ event: 'usage', data: JSON.stringify(part.usage) });
        }
      }

      if (full.trim()) {
        await createMessage({
          convId,
          userId,
          sender: 'assistant',
          content: [{ type: 'text', text: full }],
        });
      }

      reply.sse({ event: 'end', data: '[DONE]' });
    } catch (err) {
      req.log.error({ err }, 'Azure OpenAI stream failed');
      reply.sse({ event: 'error', data: 'Stream error' });
    }
  });

  // Update conversation workflow state
  app.put('/conversations/:id/workflow', {
    schema: {
      tags: ['chat'],
      summary: 'Update conversation workflow state',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { 
        type: 'object', 
        properties: { 
          workflowPaused: { type: 'boolean' },
          pausedStep: { type: 'object' }
        }, 
        required: ['workflowPaused'] 
      },
      response: { 
        200: { $ref: 'Conversation#' },
        400: { type: 'object', properties: { message: { type: 'string' }, errors: { type: 'object' } } }
      },
    },
  }, async (req, reply) => {
    const params = z.object({ id: z.string() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ message: 'Invalid params', errors: params.error.format() });
    
    const body = z.object({ 
      workflowPaused: z.boolean(),
      pausedStep: z.any().optional()
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: 'Invalid body', errors: body.error.format() });
    
    const conv = await updateConversationWorkflow(params.data.id, body.data.workflowPaused, body.data.pausedStep);
    return reply.send(conv);
  });
}
