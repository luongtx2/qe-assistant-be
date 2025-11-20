import { z } from 'zod';

export const AutomationStepSchema = z.object({
  type: z.enum(['click', 'type', 'assert', 'wait', 'scroll', 'select', 'hover']),
  selector: z.string().optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  timeout: z.number().optional(),
  description: z.string().optional(),
});

export const AutomationScriptSchema = z.object({
  _id: z.string().optional(),
  convId: z.string(),
  userId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  steps: z.array(AutomationStepSchema),
  scriptIndex: z.number().default(0), // Track current script version
  currentStepIndex: z.number().default(0), // Track current step position
  status: z.enum(['draft', 'ready', 'running', 'completed', 'failed']).default('draft'),
  result: z.record(z.any()).optional(),
  error: z.string().optional(),
  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

export const CreateAutomationScriptSchema = AutomationScriptSchema.pick({
  convId: true,
  userId: true,
  title: true,
  description: true,
  steps: true,
});

export const GenerateAutomationInputSchema = z.object({
  convId: z.string(),
  userId: z.string(),
  description: z.string(),
  domContext: z.string().optional(),
});

export type AutomationStep = z.infer<typeof AutomationStepSchema>;
export type AutomationScript = z.infer<typeof AutomationScriptSchema>;
export type CreateAutomationScript = z.infer<typeof CreateAutomationScriptSchema>;
export type GenerateAutomationInput = z.infer<typeof GenerateAutomationInputSchema>;
