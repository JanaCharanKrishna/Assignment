// backend/src/services/copilotSchema.js
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export const copilotResponseSchema = {
  type: "object",
  required: [
    "answer_title", "direct_answer", "key_points", "actions", "comparison",
    "risks", "uncertainties", "confidence", "evidence_used", "safety_note"
  ],
  properties: {
    answer_title: { type: "string" },
    direct_answer: { type: "string" },
    key_points: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["priority", "action", "rationale"],
        properties: {
          priority: { type: "string" },
          action: { type: "string" },
          rationale: { type: "string" }
        }
      }
    },
    comparison: {
      type: "object",
      required: ["summary", "delta_metrics"],
      properties: {
        summary: { type: "string" },
        delta_metrics: { type: "array", items: { type: "object" } }
      }
    },
    risks: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    confidence: {
      type: "object",
      required: ["overall", "rubric", "reason"],
      properties: {
        overall: { type: "number" },
        rubric: { type: "string" },
        reason: { type: "string" }
      }
    },
    evidence_used: {
      type: "array",
      items: {
        type: "object",
        required: ["source", "confidence", "snippet"],
        properties: {
          source: { type: "string" },
          confidence: { type: "string" },
          snippet: { type: "string" }
        }
      }
    },
    safety_note: { type: "string" }
  }
};

const validateFn = ajv.compile(copilotResponseSchema);

export function validateCopilotResponse(json) {
  const ok = validateFn(json);
  return { ok: !!ok, errors: validateFn.errors || [] };
}
