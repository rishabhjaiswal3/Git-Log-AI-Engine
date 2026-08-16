import mongoose from 'mongoose';

const ChangelogCacheSchema = new mongoose.Schema(
  {
    repoIdentifier: { type: String, required: true, index: true }, // e.g. "owner/repo"
    latestCommitSha: { type: String, required: true },
    processingMode: { type: String, required: true, enum: ['freelancer', 'company'] },
    generatedMarkdown: { type: String, required: true },
    generatedJson: { type: mongoose.Schema.Types.Mixed, required: true }, // structured LLM output, post-grounding
    droppedItems: { type: [String], default: [] }, // grounding-check audit trail
    createdAt: { type: Date, default: Date.now, expires: 2592000 }, // TTL: 30 days
  },
  { timestamps: true }
);

ChangelogCacheSchema.index(
  { repoIdentifier: 1, latestCommitSha: 1, processingMode: 1 },
  { unique: true }
);

export const ChangelogCache = mongoose.model('ChangelogCache', ChangelogCacheSchema);
