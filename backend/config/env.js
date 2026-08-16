import dotenv from 'dotenv';

dotenv.config();

export const PORT = process.env.PORT || 4000;
export const MONGODB_URI = process.env.MONGODB_URI;
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
export const MAX_INPUT_TOKENS = Number(process.env.MAX_INPUT_TOKENS) || 6000;
export const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 2000;
export const COMMIT_FETCH_LIMIT = Number(process.env.COMMIT_FETCH_LIMIT) || 20;
export const GROUNDING_MIN_OVERLAP = Number(process.env.GROUNDING_MIN_OVERLAP) || 0.2;
