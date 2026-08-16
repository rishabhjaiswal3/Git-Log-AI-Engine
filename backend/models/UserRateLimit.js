import mongoose from 'mongoose';

const UserRateLimitSchema = new mongoose.Schema(
  {
    userIpAddress: { type: String, required: true, unique: true },
    requestCountWithinMonth: { type: Number, default: 1 },
    lastRequestTimestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const UserRateLimit = mongoose.model('UserRateLimit', UserRateLimitSchema);
