/**
 * Monte Carlo resampling of a backtest's trade R-multiples: each run draws
 * trades with replacement (bootstrap) and compounds equity at a fixed
 * risk-% per trade, giving distributions of final return and max drawdown
 * plus the probability of hitting ruin-level drawdowns.
 */

export interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface MonteCarloResult {
  runs: number;
  tradesPerRun: number;
  riskPct: number;
  finalReturnPct: Percentiles;
  maxDrawdownPct: Percentiles;
  probDrawdownOver20: number; // % of runs whose max drawdown exceeded 20%
  probDrawdownOver30: number;
  riskOfRuinPct: number; // % of runs that hit the ruin drawdown
  ruinDrawdownPct: number;
}

/** Deterministic PRNG so repeated runs on the same trades give the same picture. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentiles(sorted: number[]): Percentiles {
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
  return { p5: at(5), p25: at(25), p50: at(50), p75: at(75), p95: at(95) };
}

export function runMonteCarlo(
  rMultiples: number[],
  riskPct: number,
  runs = 1000,
  ruinDrawdownPct = 50,
): MonteCarloResult | null {
  if (rMultiples.length < 5 || riskPct <= 0) return null;
  const rand = mulberry32(0xc0ffee ^ rMultiples.length);
  const n = rMultiples.length;
  const finals: number[] = [];
  const dds: number[] = [];
  let ddOver20 = 0;
  let ddOver30 = 0;
  let ruined = 0;

  for (let run = 0; run < runs; run++) {
    let equity = 1;
    let peak = 1;
    let maxDd = 0;
    for (let i = 0; i < n; i++) {
      const r = rMultiples[Math.floor(rand() * n)];
      equity *= 1 + (r * riskPct) / 100;
      if (equity <= 0) {
        equity = 0;
        maxDd = 100;
        break;
      }
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, (100 * (peak - equity)) / peak);
    }
    finals.push(100 * (equity - 1));
    dds.push(maxDd);
    if (maxDd > 20) ddOver20++;
    if (maxDd > 30) ddOver30++;
    if (maxDd >= ruinDrawdownPct) ruined++;
  }

  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    runs,
    tradesPerRun: n,
    riskPct,
    finalReturnPct: percentiles(finals),
    maxDrawdownPct: percentiles(dds),
    probDrawdownOver20: (100 * ddOver20) / runs,
    probDrawdownOver30: (100 * ddOver30) / runs,
    riskOfRuinPct: (100 * ruined) / runs,
    ruinDrawdownPct,
  };
}
