import { FastifyInstance } from 'fastify';
import { DirectAIService, AutomationStep } from '../services/direct-ai.service.js';
import { createMessage, updateConversationWorkflow } from '../services/chat.service.js';
import { AutomationService } from '../services/automation.service.js';

export async function directAIWebSocketRoutes(fastify: FastifyInstance) {
  const aiService = new DirectAIService(fastify);
  const automationService = new AutomationService();

  // Helper function to save/update automation script
  async function saveAutomationScript(
    steps: any[],
    convId: string,
    userId: string
  ) {
    try {
      // Map Direct AI steps to Automation schema format
      const mappedSteps = steps.map(step => ({
        type: step.action as 'click' | 'type' | 'assert' | 'wait' | 'scroll' | 'select' | 'hover',
        selector: step.target || '',
        text: step.description || '',
        value: step.value || '',
        description: step.description || ''
      }));

      fastify.log.info(`=== APPEND TO DATABASE ===`);
      fastify.log.info(`Conversation: ${convId}`);
      fastify.log.info(`AI generated ${mappedSteps.length} steps:`);
      mappedSteps.forEach((step, index) => {
        fastify.log.info(`  ${index + 1}. [${step.type}] ${step.description}`);
      });

      // Check if script already exists for this conversation
      const existingScripts = await automationService.findScriptsByConversation(convId);
      
      if (existingScripts.length > 0) {
        const existingScript = existingScripts[0];
        fastify.log.info({ steps: existingScript.steps.map(s => s.description) }, `Existing script has ${existingScript.steps.length} steps`);
        
        // Append all new steps (should be only 1 step now)
        const updatedSteps = [...existingScript.steps, ...mappedSteps];
        await automationService.updateScriptSteps(existingScript._id!, updatedSteps, updatedSteps.length - 1);
        fastify.log.info({ steps: updatedSteps.map(s => s.description) }, `✅ APPENDED ${mappedSteps.length} steps. Total: ${updatedSteps.length} steps`);
      } else {
        // Create new script
        await automationService.createScript({
          convId: convId,
          userId: userId,
          title: `Automation Script - ${new Date().toLocaleString()}`,
          steps: mappedSteps
        });
        fastify.log.info({ steps: mappedSteps.map(s => s.description) }, `✅ CREATED new script with ${mappedSteps.length} steps`);
      }
      fastify.log.info(`=== END APPEND ===`);
    } catch (error) {
      fastify.log.error('Failed to save automation script: ' + (error as any).message);
    }
  }

  // Handler functions (now inside scope to access saveAutomationScript)
  async function handleAutomationStart(
    connection: any,
    data: any,
    aiService: DirectAIService,
    fastify: FastifyInstance
  ) {
    const { userInput, userId, tabId, conversationId, domContext, language = 'en' } = data;

    try {
      // Step 1: Send initial message
      connection.send(JSON.stringify({
        type: 'progress',
        step: 'processing',
        message: '🤖 AI is analyzing your request...'
      }));

      // Step 2: Parse DOM context
      let domElements = [];
      try {
        // domContext is now an array, not a JSON string
        domElements = Array.isArray(domContext) ? domContext : JSON.parse(domContext || '[]');
      } catch (error) {
        fastify.log.warn(`Failed to parse DOM context: ${error}`);
      }

      // Step 3: Process with AI
      connection.send(JSON.stringify({
        type: 'progress',
        step: 'ai_processing',
        message: '🧠 AI is analyzing DOM and generating automation step...'
      }));

      const result = await aiService.processUserInput(userInput, domElements, [], language);

      if (!result.success) {
        connection.send(JSON.stringify({
          type: 'error',
          message: result.message
        }));
        return;
      }

      const plan = result.plan!;

      // Step 4: Send result
      if (plan.needsNavigation) {
        // Save assistant message for navigation pause
        try {
          const assistantMessage = `⏸️ **Navigation Required**\n\n**Step:** ${plan.steps[plan.currentStep].action} - ${plan.steps[plan.currentStep].description}\n**Target:** \`${plan.steps[plan.currentStep].target || 'none'}\`\n**Guidance:** ${plan.navigationGuidance || 'Please navigate to the required page'}`;
          
          await createMessage({
            convId: data.conversationId,
            userId: data.userId,
            sender: 'assistant',
            content: [{ type: 'text', text: assistantMessage }]
          });
        } catch (error) {
          fastify.log.error('Failed to save assistant message:' + (error as any).message);
        }

        // Save workflow state to database
        try {
          await updateConversationWorkflow(data.conversationId, true, plan.steps[plan.currentStep]);
        } catch (error) {
          fastify.log.error('Failed to save workflow state:' + (error as any).message);
        }

        connection.send(JSON.stringify({
          type: 'pause_automation',
          step: plan.steps[plan.currentStep],
          message: `⏸️ Navigation Required`,
          guidance: plan.navigationGuidance || 'Please navigate to the required page'
        }));
      } else {
        // Don't save here - wait for completion to avoid duplicates

        // Save assistant message for step generated
        try {
          const assistantMessage = `✅ **Step Generated**\n\n**Action:** ${plan.steps[plan.currentStep].action}\n**Description:** ${plan.steps[plan.currentStep].description}\n**Target:** \`${plan.steps[plan.currentStep].target || 'none'}\`${plan.steps[plan.currentStep].value ? `\n**Value:** "${plan.steps[plan.currentStep].value}"` : ''}`;
          
          await createMessage({
            convId: data.conversationId,
            userId: data.userId,
            sender: 'assistant',
            content: [{ type: 'text', text: assistantMessage }]
          });
        } catch (error) {
          fastify.log.error('Failed to save assistant message:' + (error as any).message);
        }

        connection.send(JSON.stringify({
          type: 'step_generated',
          step: plan.steps[plan.currentStep],
          steps: plan.steps, // Send all steps generated in this chat turn
          message: `✅ Next step: ${plan.steps[plan.currentStep].description}`
        }));

        // Don't save here - will save in handleAutomationContinue

        // If automation is complete
        if (plan.isComplete) {

          // Save assistant message to database
          try {
            const assistantMessage = `🎉 Automation completed! Generated ${plan.steps.length} steps.\n\n**Steps:**\n${plan.steps.map((step, i) => `${i + 1}. **${step.action}** - ${step.description}\n   Target: \`${step.target || 'none'}\`${step.value ? `\n   Value: "${step.value}"` : ''}`).join('\n\n')}`;
            
            await createMessage({
              convId: data.conversationId,
              userId: data.userId,
              sender: 'assistant',
              content: [{ type: 'text', text: assistantMessage }]
            });
          } catch (error) {
            fastify.log.error('Failed to save assistant message:' + (error as any).message);
          }

          // Clear workflow state when automation completes
          try {
            await updateConversationWorkflow(data.conversationId, false, null);
          } catch (error) {
            fastify.log.error('Failed to clear workflow state:' + (error as any).message);
          }

          connection.send(JSON.stringify({
            type: 'automation_complete',
            steps: plan.steps,
            message: `🎉 Automation completed! Generated ${plan.steps.length} steps.`,
          }));
        } else {
          // Continue workflow - generate next step
          connection.send(JSON.stringify({
            type: 'progress',
            step: 'continuing',
            message: '🔄 Continuing automation workflow...',
          }));
          
          // Generate next step with fresh DOM but keep existing steps context
          const nextResult = await aiService.processUserInput(userInput, domElements, plan.steps, language);
          
          if (nextResult.success && nextResult.plan) {
            const nextPlan = nextResult.plan;
            
            if (nextPlan.needsNavigation) {
              connection.send(JSON.stringify({
                type: 'pause_automation',
                step: nextPlan.steps[nextPlan.currentStep],
                message: `⏸️ Navigation Required`,
                guidance: nextPlan.navigationGuidance || 'Please navigate to the required page',
              }));
            } else {
              // Don't save here - wait for completion to avoid duplicates

              connection.send(JSON.stringify({
                type: 'step_generated',
                step: nextPlan.steps[nextPlan.currentStep],
                steps: nextPlan.steps, // Send all steps generated in this chat turn
                message: `✅ Next step: ${nextPlan.steps[nextPlan.currentStep].description}`,
              }));
              
              // Always save automation script when steps are generated
              await saveAutomationScript(nextPlan.steps, data.conversationId, data.userId);
              
              if (nextPlan.isComplete) {

                // Save assistant message to database
                try {
                  const assistantMessage = `🎉 Automation completed! Generated ${nextPlan.steps.length} steps.\n\n**Steps:**\n${nextPlan.steps.map((step, i) => `${i + 1}. **${step.action}** - ${step.description}\n   Target: \`${step.target || 'none'}\`${step.value ? `\n   Value: "${step.value}"` : ''}`).join('\n\n')}`;
                  
                  await createMessage({
                    convId: data.conversationId,
                    userId: data.userId,
                    sender: 'assistant',
                    content: [{ type: 'text', text: assistantMessage }]
                  });
                } catch (error) {
                  fastify.log.error('Failed to save assistant message:' + (error as any).message);
                }

                connection.send(JSON.stringify({
                  type: 'automation_complete',
                  steps: nextPlan.steps,
                  message: `🎉 Automation completed! Generated ${nextPlan.steps.length} steps.`,
                }));
              }
            }
          }
        }
      }

    } catch (error: any) {
      fastify.log.error('Automation start failed:' + (error as any).message);
      connection.send(JSON.stringify({
        type: 'error',
        message: `Automation failed: ${(error as any).message}`
      }));
    }
  }

  async function handleAutomationContinue(
    connection: any,
    data: any,
    aiService: DirectAIService,
    fastify: FastifyInstance
  ) {
    const { userInput, userId, tabId, conversationId, domContext, existingSteps, language = 'en' } = data;

    try {
      // Step 1: Send progress
      connection.send(JSON.stringify({
        type: 'progress',
        step: 'continuing',
        message: '🔄 Continuing automation with new DOM context...',
      }));

      // Step 2: Parse DOM context
      let domElements = [];
      try {
        // domContext is now an array, not a JSON string
        domElements = Array.isArray(domContext) ? domContext : JSON.parse(domContext || '[]');
      } catch (error) {
        fastify.log.warn(`Failed to parse DOM context: ${error}`);
      }

      // Step 3: Process with AI (with existing steps)
      connection.send(JSON.stringify({
        type: 'progress',
        step: 'ai_processing',
        message: '🧠 AI is analyzing new DOM context...',
      }));

      const result = await aiService.processUserInput(userInput, domElements, existingSteps, language);

      if (!result.success) {
        connection.send(JSON.stringify({
          type: 'error',
          message: result.message
        }));
        return;
      }

      const plan = result.plan!;

      // Step 4: Send result
      if (plan.needsNavigation) {
        // Save assistant message for navigation pause
        try {
          const assistantMessage = `⏸️ **Navigation Required**\n\n**Step:** ${plan.steps[plan.currentStep].action} - ${plan.steps[plan.currentStep].description}\n**Target:** \`${plan.steps[plan.currentStep].target || 'none'}\`\n**Guidance:** ${plan.navigationGuidance || 'Please navigate to the required page'}`;
          
          await createMessage({
            convId: conversationId,
            userId: userId,
            sender: 'assistant',
            content: [{ type: 'text', text: assistantMessage }]
          });
        } catch (error) {
          fastify.log.error('Failed to save assistant message:' + (error as any).message);
        }

        // Save workflow state to database
        try {
          await updateConversationWorkflow(conversationId, true, plan.steps[plan.currentStep]);
        } catch (error) {
          fastify.log.error('Failed to save workflow state:' + (error as any).message);
        }

        connection.send(JSON.stringify({
          type: 'pause_automation',
          step: plan.steps[plan.currentStep],
          message: `⏸️ Navigation Required`,
          guidance: plan.navigationGuidance || 'Please navigate to the required page',
        }));
      } else {
        // Don't save here - wait for completion to avoid duplicates

        // Save assistant message for step generated
        try {
          const assistantMessage = `✅ **Step Generated**\n\n**Action:** ${plan.steps[plan.currentStep].action}\n**Description:** ${plan.steps[plan.currentStep].description}\n**Target:** \`${plan.steps[plan.currentStep].target || 'none'}\`${plan.steps[plan.currentStep].value ? `\n**Value:** "${plan.steps[plan.currentStep].value}"` : ''}`;
          
          await createMessage({
            convId: conversationId,
            userId: userId,
            sender: 'assistant',
            content: [{ type: 'text', text: assistantMessage }]
          });
        } catch (error) {
          fastify.log.error('Failed to save assistant message:' + (error as any).message);
        }

        connection.send(JSON.stringify({
          type: 'step_generated',
          step: plan.steps[plan.currentStep],
          steps: plan.steps, // Send all steps generated in this chat turn
          message: `✅ Next step: ${plan.steps[plan.currentStep].description}`,
        }));

        // Save automation script when steps are generated
        await saveAutomationScript(plan.steps, conversationId, userId);

        // If automation is complete
        if (plan.isComplete) {

          // Save assistant message to database
          try {
            const assistantMessage = `🎉 Automation completed! Generated ${plan.steps.length} steps.\n\n**Steps:**\n${plan.steps.map((step, i) => `${i + 1}. **${step.action}** - ${step.description}\n   Target: \`${step.target || 'none'}\`${step.value ? `\n   Value: "${step.value}"` : ''}`).join('\n\n')}`;
            
            await createMessage({
              convId: data.conversationId,
              userId: data.userId,
              sender: 'assistant',
              content: [{ type: 'text', text: assistantMessage }]
            });
          } catch (error) {
            fastify.log.error('Failed to save assistant message:' + (error as any).message);
          }

          // Clear workflow state when automation completes
          try {
            await updateConversationWorkflow(conversationId, false, null);
          } catch (error) {
            fastify.log.error('Failed to clear workflow state:' + (error as any).message);
          }

          connection.send(JSON.stringify({
            type: 'automation_complete',
            steps: plan.steps,
            message: `🎉 Automation completed! Generated ${plan.steps.length} steps.`,
          }));
        }
      }

    } catch (error: any) {
      fastify.log.error('Automation continue failed:' + (error as any).message);
      connection.send(JSON.stringify({
        type: 'error',
        message: `Automation continue failed: ${(error as any).message}`
      }));
    }
  }

  // WebSocket endpoint for direct AI automation
  fastify.register(async function (fastify) {
    fastify.get('/ws/direct-ai', { websocket: true }, (connection, req) => {
      fastify.log.info(`Direct AI WebSocket connection established from: ${req.headers['user-agent']}`);

      connection.on('message', async (message: any) => {
        try {
          const data = JSON.parse(message.toString());
          fastify.log.info('Direct AI WebSocket message received:', data);

          if (data.type === 'start_automation') {
            await handleAutomationStart(connection, data, aiService, fastify);
          } else if (data.type === 'continue_automation') {
            await handleAutomationContinue(connection, data, aiService, fastify);
          }
        } catch (error: any) {
          fastify.log.error('Direct AI WebSocket message error:' + (error as any).message);
          connection.send(JSON.stringify({
            type: 'error',
            message: (error as any).message
          }));
        }
      });

      connection.on('close', () => {
        fastify.log.info('Direct AI WebSocket connection closed');
      });
    });
  });
}

