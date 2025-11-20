import { Collection, ObjectId } from 'mongodb';
import { getCollection } from '../db/mongo.js';
import { Conversation, Message } from '../schemas/chat.schema.js';

function conversationsCol(): Collection<Conversation> {
  return getCollection<Conversation>('conversations');
}
function messagesCol(): Collection<Message> {
  return getCollection<Message>('messages');
}

export async function createConversation(userId: string, title?: string): Promise<Conversation> {
  const col = conversationsCol();
  const doc: Omit<Conversation, '_id'> = {
    userId,
    title: title ?? 'New chat',
    status: 'active',
    lastMsgAt: new Date(),
    workflowPaused: false,
    pausedStep: undefined,
    createdAt: new Date(),
  };
  const res = await col.insertOne(doc as any);
  return { _id: res.insertedId, ...doc } as Conversation;
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const col = conversationsCol();
  return await col.find({ userId }).sort({ lastMsgAt: -1 }).toArray();
}

export async function createMessage(input: Omit<Message, '_id' | 'createdAt'>): Promise<Message> {
  const col = messagesCol();
  const doc: Omit<Message, '_id'> = { ...input, createdAt: new Date() };
  const res = await col.insertOne(doc as any);
  // update conv lastMsgAt
  await conversationsCol().updateOne(
    { _id: new ObjectId(input.convId) as any },
    { $set: { lastMsgAt: new Date() } }
  );
  return { _id: res.insertedId, ...doc } as Message;
}

export async function listMessages(convId: string): Promise<Message[]> {
  const col = messagesCol();
  return await col.find({ convId }).sort({ createdAt: 1 }).toArray();
}

export async function listLastMessages(convId: string, limit: number): Promise<Message[]> {
  const col = messagesCol();
  return await col.find({ convId }).sort({ createdAt: -1 }).limit(limit).toArray().then(arr => arr.reverse());
}

export async function updateConversationWorkflow(convId: string, workflowPaused: boolean, pausedStep?: any): Promise<Conversation | null> {
  const col = conversationsCol();
  const updateData: any = { workflowPaused };
  if (pausedStep !== undefined) {
    updateData.pausedStep = pausedStep;
  }
  
  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(convId) },
    { $set: updateData },
    { returnDocument: 'after' }
  );
  
  return result || null;
}
