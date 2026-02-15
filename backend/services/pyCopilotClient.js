// backend/services/pyCopilotClient.js
import axios from "axios";

const PY_AI_BASE = (process.env.PY_AI_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");
const PY_COPILOT_TIMEOUT_MS = Number(process.env.PY_COPILOT_TIMEOUT_MS || 45000);

/**
 * Calls Python copilot service.
 * Returns parsed JSON body from Python service.
 */



export async function callPythonCopilot(payload) {
  const base = process.env.PY_AI_BASE || "http://127.0.0.1:8000";
  const url = `${base}/copilot/query`; // adjust if your python path differs
  const t0 = Date.now();

  let res;
  let text = "";
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`python_network_error: ${e?.message || e}`);
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep text as raw
  }

  if (!res.ok) {
    const detail =
      (json && (json.detail || json.error || json.message)) ||
      text ||
      `HTTP ${res.status}`;
    throw new Error(`python_http_${res.status}: ${detail}`);
  }

  return json ?? {};
}



// Optional default export too (safe if any file imports default)
export default { callPythonCopilot };
