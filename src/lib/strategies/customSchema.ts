import { z } from "zod";
import { CONDITION_IDS } from "./custom";

export const customStrategySchema = z.object({
  name: z.string().min(1).max(60),
  conditions: z
    .array(
      z.object({
        id: z.enum(CONDITION_IDS as [string, ...string[]]).transform((v) => v as (typeof CONDITION_IDS)[number]),
        weight: z.number().min(0).max(100),
      }),
    )
    .min(1)
    .max(CONDITION_IDS.length),
  minScore: z.number().min(0).max(100),
});
