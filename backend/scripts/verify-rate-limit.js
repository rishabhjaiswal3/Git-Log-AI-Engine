import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { UserRateLimit } from '../models/UserRateLimit.js';
import { checkAndIncrementRateLimit } from '../adapters/cache.repository.js';

const TEST_IP = '203.0.113.7'; // TEST-NET-3, RFC 5737 — safe to use as a fixture

async function main() {
  await connectDB();
  await UserRateLimit.init(); // ensure the unique index is built before we race against it

  await UserRateLimit.deleteMany({ userIpAddress: TEST_IP });

  // --- Atomicity: N concurrent calls for a brand-new IP should never lose an increment ---
  const CONCURRENCY = 25;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => checkAndIncrementRateLimit(TEST_IP))
  );
  const afterConcurrent = await UserRateLimit.findOne({ userIpAddress: TEST_IP });
  console.log(
    'Atomic increment under concurrency:',
    afterConcurrent?.requestCountWithinMonth === CONCURRENCY
      ? 'PASS'
      : `FAIL (expected ${CONCURRENCY}, got ${afterConcurrent?.requestCountWithinMonth})`
  );

  // --- Only one document should exist for the IP, not one per concurrent racer ---
  const docCount = await UserRateLimit.countDocuments({ userIpAddress: TEST_IP });
  console.log('Single document per IP (no upsert-race duplicates):', docCount === 1 ? 'PASS' : `FAIL (found ${docCount} docs)`);

  // --- Monthly reset: a request after a previous-month timestamp resets the counter to 1 ---
  const lastMonth = new Date();
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  await UserRateLimit.updateOne({ userIpAddress: TEST_IP }, { $set: { lastRequestTimestamp: lastMonth } });

  await checkAndIncrementRateLimit(TEST_IP);
  const afterReset = await UserRateLimit.findOne({ userIpAddress: TEST_IP });
  console.log('Monthly reset resets counter to 1:', afterReset?.requestCountWithinMonth === 1 ? 'PASS' : `FAIL (got ${afterReset?.requestCountWithinMonth})`);

  await UserRateLimit.deleteMany({ userIpAddress: TEST_IP });
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Verification script failed:', err);
  process.exit(1);
});
