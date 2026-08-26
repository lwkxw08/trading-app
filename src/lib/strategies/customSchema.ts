import { z } from "zod";
import { CONDITION_IDS } from "./custom";
import { METRIC_IDS } from "./userConditions";

const userClauseSchema = z.object({
  metric: z.enum(METRIC_IDS as [string, ...string[]]).transform((v) => v as (typeof METRIC_IDS)[number]),
  op: z.enum(["lt", "gt"]),
  value: z.number().min(-10000).max(10000),
});

export const userConditionSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(60),
  shortMode: z.enum(["mirror", "same"]),
  clauses: z.array(userClauseSchema).min(1).max(6),
});

const stopRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("default") }),
  z.object({ type: z.literal("atr"), multiple: z.number().min(0.1).max(20) }),
  z.object({ type: z.literal("percent"), percent: z.number().min(0.05).max(50) }),
  z.object({ type: z.literal("swing"), bufferAtr: z.number().min(0).max(5) }),
  z.object({ type: z.literal("hvn"), bufferAtr: z.number().min(0).max(5) }),
]);

const targetRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("default") }),
  z.object({ type: z.literal("rr"), ratio: z.number().min(0.2).max(20) }),
  z.object({ type: z.literal("atr"), multiple: z.number().min(0.1).max(30) }),
  z.object({ type: z.literal("swing") }),
  z.object({ type: z.literal("hvn") }),
]);

export const riskSettingsSchema = z.object({
  stop: stopRuleSchema,
  target: targetRuleSchema,
});

export const customStrategySchema = z.object({
  name: z.string().min(1).max(60),
  conditions: z
    .array(
      z.object({
        id: z.enum(CONDITION_IDS as [string, ...string[]]).transform((v) => v as (typeof CONDITION_IDS)[number]),
        weight: z.number().min(0).max(100),
      }),
    )
    .max(CONDITION_IDS.length),
  minScore: z.number().min(0).max(100),
  userConditions: z
    .array(
      z.object({
        condition: userConditionSchema,
        weight: z.number().min(0).max(100),
      }),
    )
    .max(40)
    .optional(),
  risk: riskSettingsSchema.optional(),
}).refine((s) => s.conditions.length + (s.userConditions?.length ?? 0) > 0, {
  message: "at least one condition is required",
});
