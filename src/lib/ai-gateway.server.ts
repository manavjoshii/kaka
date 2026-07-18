import { createGoogleGenerativeAI } from "@ai-sdk/google";

export function createAiProvider(apiKey: string) {
  return createGoogleGenerativeAI({ apiKey });
}
