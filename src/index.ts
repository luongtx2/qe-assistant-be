import 'dotenv/config';
import { buildApp } from './app.js';
import { connectMongo } from './db/mongo.js';

const port = Number(process.env.PORT || 3000);

async function main() {
  await connectMongo();
  const app = buildApp();
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server listening on ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
