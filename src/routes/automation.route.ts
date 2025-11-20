import { FastifyInstance } from 'fastify';
import { AutomationService } from '../services/automation.service.js';
import { GenerateAutomationInputSchema, CreateAutomationScriptSchema } from '../schemas/automation.schema.js';

export async function automationRoutes(fastify: FastifyInstance) {
  const automationService = new AutomationService();

  // POST /api/automation/generate
  fastify.post('/automation/generate', {
    schema: {
      tags: ['Automation'],
      summary: 'Generate automation script using AI',
      body: {
        type: 'object',
        required: ['convId', 'userId', 'description'],
        properties: {
          convId: { type: 'string' },
          userId: { type: 'string' },
          description: { type: 'string' },
          domContext: { type: 'string' },
        },
      },
      response: { 200: { $ref: 'AutomationScript#' } },
    },
    handler: async (request, reply) => {
      const input = GenerateAutomationInputSchema.parse(request.body);
      const script = await automationService.generateAutomationScript(input);
      reply.send(script);
    },
  });

  // POST /api/automation/scripts
  fastify.post('/automation/scripts', {
    schema: {
      tags: ['Automation'],
      summary: 'Create a new automation script',
      body: {
        type: 'object',
        required: ['convId', 'userId', 'title', 'steps'],
        properties: {
          convId: { type: 'string' },
          userId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: ['click', 'type', 'assert', 'wait', 'scroll', 'select', 'hover'] },
                selector: { type: 'string' },
                text: { type: 'string' },
                value: { type: 'string' },
                timeout: { type: 'number' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      response: { 200: { $ref: 'AutomationScript#' } },
    },
    handler: async (request, reply) => {
      const input = CreateAutomationScriptSchema.parse(request.body);
      const script = await automationService.createScript(input);
      reply.send(script);
    },
  });

  // GET /api/automation/scripts/:convId
  fastify.get('/automation/scripts/:convId', {
    schema: {
      tags: ['Automation'],
      summary: 'Get automation scripts for a conversation',
      params: {
        type: 'object',
        properties: {
          convId: { type: 'string', description: 'Conversation ID' },
        },
        required: ['convId'],
      },
      response: { 200: { type: 'array', items: { $ref: 'AutomationScript#' } } },
    },
    handler: async (request, reply) => {
      const { convId } = request.params as { convId: string };
      const scripts = await automationService.findScriptsByConversation(convId);
      reply.send(scripts);
    },
  });

  // GET /api/automation/script/:id
  fastify.get('/automation/script/:id', {
    schema: {
      tags: ['Automation'],
      summary: 'Get automation script by ID',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Script ID' },
        },
        required: ['id'],
      },
      response: { 
        200: { $ref: 'AutomationScript#' },
        404: { type: 'object', properties: { message: { type: 'string' } } }
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const script = await automationService.findScriptById(id);
      if (!script) {
        reply.status(404).send({ message: 'Script not found' });
        return;
      }
      reply.send(script);
    },
  });

  // POST /api/automation/execute/:id
  fastify.post('/automation/execute/:id', {
    schema: {
      tags: ['Automation'],
      summary: 'Execute an automation script',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Script ID' },
        },
        required: ['id'],
      },
      response: { 
        200: { 
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            result: { type: 'object' },
            error: { type: 'string' },
          },
        } 
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await automationService.executeScript(id);
      reply.send(result);
    },
  });

  // POST /api/automation/scripts/:id/remove-step
  fastify.post('/automation/scripts/:id/remove-step', {
    schema: {
      tags: ['Automation'],
      summary: 'Remove a step from automation script',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Script ID' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['stepIndex'],
        properties: {
          stepIndex: { type: 'number', description: 'Index of step to remove' },
        },
      },
      response: { 
        200: { 
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        404: { 
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        400: { 
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        500: { 
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        }
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const { stepIndex } = request.body as { stepIndex: number };
      
      try {
        fastify.log.info(`Remove step request: scriptId=${id}, stepIndex=${stepIndex}`);
        
        const script = await automationService.findScriptById(id);
        if (!script) {
          fastify.log.error(`Script not found: ${id}`);
          reply.status(404).send({ success: false, message: 'Script not found' });
          return;
        }

        fastify.log.info(`Script found with ${script.steps.length} steps`);
        
        if (stepIndex < 0 || stepIndex >= script.steps.length) {
          fastify.log.error(`Invalid step index: ${stepIndex}, script has ${script.steps.length} steps`);
          reply.status(400).send({ success: false, message: 'Invalid step index' });
          return;
        }

        // Remove step at the specified index
        const updatedSteps = script.steps.filter((_, index) => index !== stepIndex);
        
        // Update script with new steps
        await automationService.updateScriptSteps(id, updatedSteps, Math.max(0, stepIndex - 1));
        
        reply.send({ success: true, message: 'Step removed successfully' });
      } catch (error: any) {
        fastify.log.error('Remove step error:', error);
        reply.status(500).send({ success: false, message: error.message || 'Failed to remove step' });
      }
    },
  });
}
