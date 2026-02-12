// backend/services/narrativeService.js
import { generateNarrativeWithFallback } from "./llmClient.js";

export async function buildNarrative({ wellId, fromDepth, toDepth, curves, deterministic }) {
  const systemPrompt = `
You are a petroleum well-log interpretation assistant.
Rules:
1) Use ONLY the evidence provided.
2) Do NOT invent measurements, formations, or causes.
3) Be concise and technical.
4) Output VALID JSON ONLY with keys:
   summary_bullets (string[]),
   interval_explanations (array of {curve, fromDepth, toDepth, explanation, confidence}),
   recommendations (string[]),
   limitations (string[])
`;

  const userPrompt = JSON.stringify({
    task: "Create interpretation narrative from deterministic analysis",
    context: { wellId, fromDepth, toDepth, curves },
    evidence: deterministic,
    constraints: {
      max_summary_bullets: 4,
      max_interval_explanations: 8,
      max_recommendations: 5
    }
  });

  return generateNarrativeWithFallback({ systemPrompt, userPrompt });
}
