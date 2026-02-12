// backend/services/llmClient.js
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const MODELS = [
  process.env.LLM_PRIMARY || "meta-llama/llama-4-scout-17b-16e-instruct",
  process.env.LLM_FALLBACK_1 || "groq/compound-mini",
  process.env.LLM_FALLBACK_2 || "llama-3.1-8b-instant",
];

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractJson(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{") && t.endsWith("}")) return JSON.parse(t);
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("No JSON object found in LLM response");
}

async function chatOnce({ model, systemPrompt, userPrompt, maxTokens = 700 }) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      top_p: 1,
      stream: false,
      max_completion_tokens: maxTokens,
    };

    // Keep compound tools disabled for this internal deterministic+narrative flow
    if (model.startsWith("groq/compound")) {
      body.compound_custom = { tools: { enabled_tools: [] } };
    }

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}

    if (!res.ok) {
      const msg = json?.error?.message || `Groq error ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty LLM content");
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

export async function buildNarrativeWithFallback({ wellId, fromDepth, toDepth, curves, deterministic }) {
  const systemPrompt = `
You are a well-log interpretation assistant.
Rules:
1) Use ONLY provided evidence. No invented facts.
2) Keep output concise, technical, actionable.
3) Return VALID JSON ONLY with keys:
summary_bullets (string[]),
interval_explanations (array of {curve, fromDepth, toDepth, explanation, confidence}),
recommendations (string[]),
limitations (string[])
`;

  const userPrompt = JSON.stringify({
    task: "Generate interpretation narrative from deterministic evidence",
    context: { wellId, fromDepth, toDepth, curves },
    evidence: deterministic,
    output_limits: { summary_bullets_max: 4, interval_explanations_max: 8, recommendations_max: 5 },
  });

  let lastErr = null;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const narrative = await chatOnce({ model, systemPrompt, userPrompt, maxTokens: 700 });
        return { modelUsed: model, narrative };
      } catch (e) {
        lastErr = e;
        const retryable = [408, 429, 500, 502, 503, 504].includes(e?.status);
        if (attempt === 0 && retryable) {
          await sleep(500);
          continue;
        }
        break;
      }
    }
  }

  throw lastErr || new Error("All LLM models failed");
}
