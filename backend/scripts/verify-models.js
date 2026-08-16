import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { ChangelogCache } from '../models/ChangelogCache.js';
import { UserRateLimit } from '../models/UserRateLimit.js';

async function main() {
  await connectDB();
  await ChangelogCache.init(); // ensure indexes (incl. the unique compound index) are built before we test them

  await ChangelogCache.deleteMany({ repoIdentifier: 'verify/fixture' });
  await UserRateLimit.deleteMany({ userIpAddress: '127.0.0.1' });

  const cache = await ChangelogCache.create({
    repoIdentifier: 'verify/fixture',
    latestCommitSha: 'abc123',
    processingMode: 'company',
    generatedMarkdown: '## Test',
    generatedJson: { whatsNew: [], improvements: [], bugFixes: [] },
  });
  const foundCache = await ChangelogCache.findById(cache._id);
  console.log('ChangelogCache write+read:', foundCache?.repoIdentifier === 'verify/fixture' ? 'PASS' : 'FAIL');

  // duplicate on the unique compound index should be rejected
  let duplicateRejected = false;
  try {
    await ChangelogCache.create({
      repoIdentifier: 'verify/fixture',
      latestCommitSha: 'abc123',
      processingMode: 'company',
      generatedMarkdown: '## Duplicate',
      generatedJson: {},
    });
  } catch (err) {
    duplicateRejected = err.code === 11000;
  }
  console.log('ChangelogCache unique index enforced:', duplicateRejected ? 'PASS' : 'FAIL');

  const rateLimit = await UserRateLimit.create({ userIpAddress: '127.0.0.1' });
  const foundRateLimit = await UserRateLimit.findById(rateLimit._id);
  console.log('UserRateLimit write+read:', foundRateLimit?.requestCountWithinMonth === 1 ? 'PASS' : 'FAIL');

  await ChangelogCache.deleteMany({ repoIdentifier: 'verify/fixture' });
  await UserRateLimit.deleteMany({ userIpAddress: '127.0.0.1' });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Verification script failed:', err);
  process.exit(1);
});
