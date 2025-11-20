import { MongoClient, Db, Collection, Document } from 'mongodb';
import pino from 'pino';

const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<void> {
  const uri = process.env.COSMOS_URI;
  const dbName = process.env.COSMOS_DB || 'corp_extension';

  if (!uri) throw new Error('Missing COSMOS_URI');

  if (client && db) return;

  client = new MongoClient(uri, { retryWrites: false });
  await client.connect();
  db = client.db(dbName);
  logger.info('Connected to Cosmos MongoDB');
}

export function getCollection<T extends Document = Document>(name: string): Collection<T> {
  if (!db) throw new Error('Database not initialized');
  return db.collection<T>(name);
}
