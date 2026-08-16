import express from 'express';
import cors from 'cors';
import { connectDB } from './config/db.js';
import { PORT } from './config/env.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`GitLog AI Engine backend listening on port ${PORT}`);
  });
}

start();
