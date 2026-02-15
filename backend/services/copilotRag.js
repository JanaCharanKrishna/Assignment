import { z } from "zod";

export const CopilotOutputSchema = z.object({
  mode: z.enum(["data_qa", "ops", "compare"]),
  answer_title: z.string().min(1),
  direct_answer: z.string().min(1),
  key_points: z.array(z.string()).default([]),
  evidence_used: z.array(
    z.object({
      source: z.enum(["selected_interval", "deterministic", "curve_stats", "playbook", "history"]),
      snippet: z.string().min(1),
      confidence: z.enum(["high", "medium", "low"]),
    })
  ).default([]),
  actions: z.array(
    z.object({
      action: z.string().min(1),
      priority: z.enum(["high", "medium", "low"]),
      rationale: z.string().min(1),
    })
  ).default([]),
  risks: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  comparison: z.object({
    summary: z.string().default(""),
    delta_metrics: z.array(
      z.object({
        metric: z.string(),
        current: z.union([z.string(), z.number()]),
        baseline: z.union([z.string(), z.number()]),
        delta: z.union([z.string(), z.number()]),
      })
    ).default([]),
  }).default({ summary: "", delta_metrics: [] }),
  confidence: z.object({
    overall: z.number().min(0).max(1),
    rubric: z.enum(["high", "medium", "low"]),
    reason: z.string().min(1),
  }),
  safety_note: z.string(),
});

export function validateCopilotOutput(obj) {
  const parsed = CopilotOutputSchema.safeParse(obj);
  return parsed;
}
