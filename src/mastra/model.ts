// Set AI_PROVIDER in .env to switch all agents at once.
// Each provider's model is read from {PROVIDER}_MODEL (e.g. GROQ_MODEL, OPENAI_MODEL).

const provider = (process.env.AI_PROVIDER ?? 'groq').trim().toUpperCase();
const model = process.env[`${provider}_MODEL`]?.trim();

if (!model) {
  throw new Error(`AI model not configured: set ${provider}_MODEL in your .env file`);
}

export const defaultModel: string = `${provider.toLowerCase()}/${model}`;
