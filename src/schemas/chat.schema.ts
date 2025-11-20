import { z } from 'zod';

export const ConversationSchema = z.object({
  _id: z.any().optional(),
  userId: z.string(),
  title: z.string().default('New chat'),
  status: z.string().default('active'),
  lastMsgAt: z.date().optional(),
  // Workflow state for automation
  workflowPaused: z.boolean().default(false),
  pausedStep: z.any().optional(),
  createdAt: z.date().default(() => new Date()),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageContentSchema = z.array(
  z.object({
    type: z.enum(['text']),
    text: z.string(),
  })
);

export const MessageSchema = z.object({
  _id: z.any().optional(),
  convId: z.string(),
  userId: z.string(),
  sender: z.enum(['user', 'assistant']),
  content: MessageContentSchema,
  createdAt: z.date().default(() => new Date()),
});
export type Message = z.infer<typeof MessageSchema>;
