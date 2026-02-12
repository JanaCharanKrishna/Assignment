// backend/services/aiClient.js
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";

export async function callAiInterpret(payload) {
  const res = await fetch(`${AI_SERVICE_URL}/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`AI service returned non-JSON: ${text.slice(0, 180)}`);
  }

  if (!res.ok) {
    throw new Error(json?.error || `AI service failed (${res.status})`);
  }
  return json;
}
