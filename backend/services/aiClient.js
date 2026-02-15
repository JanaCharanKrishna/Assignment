// backend/services/aiClient.js
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);

export async function callAiInterpret(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(`${AI_SERVICE_URL}/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`AI service returned non-JSON: ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      throw new Error(json?.error || `AI service failed (${res.status})`);
    }
    return json;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`AI service timeout after ${AI_TIMEOUT_MS}ms at ${AI_SERVICE_URL}/interpret`);
    }
    throw new Error(`AI service unreachable at ${AI_SERVICE_URL}/interpret: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}
