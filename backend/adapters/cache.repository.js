import { UserRateLimit } from '../models/UserRateLimit.js';

// ChangelogCache reads/writes (getCached/saveResult) join this file in Phase 11.

function currentYearMonthUTC(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Atomic per-IP monthly counter: resets to 1 when the last request fell in a
// previous calendar month, otherwise increments. Implemented as a single
// aggregation-pipeline update (not read-then-write) so concurrent requests
// from the same IP can never race and silently lose an increment.
export async function checkAndIncrementRateLimit(ip) {
  const now = new Date();
  const currentYearMonth = currentYearMonthUTC(now);

  const pipeline = [
    {
      $set: {
        requestCountWithinMonth: {
          $cond: {
            if: {
              $eq: [
                {
                  $dateToString: {
                    format: '%Y-%m',
                    date: { $ifNull: ['$lastRequestTimestamp', now] },
                    timezone: 'UTC',
                  },
                },
                currentYearMonth,
              ],
            },
            then: { $add: [{ $ifNull: ['$requestCountWithinMonth', 0] }, 1] },
            else: 1,
          },
        },
        lastRequestTimestamp: now,
      },
    },
  ];

  const options = { upsert: true, returnDocument: 'after', updatePipeline: true };

  try {
    return await UserRateLimit.findOneAndUpdate({ userIpAddress: ip }, pipeline, options);
  } catch (err) {
    // Two brand-new-IP requests can both attempt to insert at once; the loser
    // of that race gets a duplicate-key error against the unique index.
    // The document now exists, so retrying once turns it into a plain update.
    if (err.code === 11000) {
      return UserRateLimit.findOneAndUpdate({ userIpAddress: ip }, pipeline, options);
    }
    throw err;
  }
}
