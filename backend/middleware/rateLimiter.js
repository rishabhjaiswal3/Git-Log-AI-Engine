import { checkAndIncrementRateLimit } from '../adapters/cache.repository.js';
import { RateLimitError } from '../errors/AppError.js';
import { MAX_REQUESTS_PER_MONTH } from '../config/env.js';

function secondsUntilNextMonthUTC(now) {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.ceil((nextMonth.getTime() - now.getTime()) / 1000);
}

export async function rateLimiter(req, res, next) {
  try {
    const record = await checkAndIncrementRateLimit(req.ip);

    if (record.requestCountWithinMonth > MAX_REQUESTS_PER_MONTH) {
      const retryAfterSeconds = secondsUntilNextMonthUTC(new Date());
      throw new RateLimitError('Monthly request limit exceeded.', retryAfterSeconds);
    }

    next();
  } catch (err) {
    next(err);
  }
}
