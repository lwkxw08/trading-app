import type { CustomStrategy } from "./custom";

/**
 * Pre-built strategy presets: complete CustomStrategy configurations users can
 * load into the Strategy Lab editor, tweak, save and backtest like any saved
 * strategy.
 */

export interface StrategyPreset {
  id: string;
  /** short pitch shown in the preset list */
  summary: string;
  strategy: CustomStrategy;
}

export const PULLBACK_TO_VALUE_STRATEGY_NAME = "HTF Pullback to Value";

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: "pullback_to_value",
    summary:
      "High win-rate profile that works across stocks/ETFs/forex/crypto: trade only with the higher-timeframe trend, wait for a pullback into a value zone (FVG/order block meeting heavy volume), require a liquidity sweep into the zone, and take the easy portion of the move — SL beyond the recent swing, TP at the next HVN (falls back to structure).",
    strategy: {
      name: PULLBACK_TO_VALUE_STRATEGY_NAME,
      minScore: 70,
      conditions: [
        { id: "htf_alignment", weight: 16 },
        { id: "trend_alignment", weight: 12 },
        { id: "fvg_retest", weight: 15 },
        { id: "order_block", weight: 10 },
        { id: "hvn_level", weight: 13 },
        { id: "volume_profile_value", weight: 10 },
        { id: "hvn_fvg_pullback", weight: 14 },
        { id: "liquidity_sweep", weight: 16 },
        { id: "choch", weight: 8 },
      ],
      risk: {
        stop: { type: "swing", bufferAtr: 0.25 },
        target: { type: "hvn" },
      },
    },
  },
];
