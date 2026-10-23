// Suggested cache-read share of input tokens per surface (ADR-0034 decision 8).
// Figures are planning defaults for the budget assistant, never enforcement.
// No source states an average cache share for any of these surfaces
// (docs/UNKNOWNS.md G-R1, retrieved 2026-10-22). Evidence classes:
// - illustrative: derived from an example output in the product's own docs;
// - analogue: a published figure for a different but similar workload;
// - assumed: no figure for the workload; the source reports cost reductions only.
// Each should be replaced with the group's observed value from the chargeback workbook.

import type { Surface } from "./group-registration.ts";

export type CacheEvidence = "illustrative" | "analogue" | "assumed" | "none";

export interface CacheSuggestion {
  percent: number | null;
  basis: CacheEvidence;
  // false: the surface's traffic does not pass through the gateway (UNKNOWNS G-R2),
  // so its figure is shown for reference but does not set a group's suggestion.
  gatewayRouted: boolean;
  source: string;
  note: string;
}

export const CACHE_SUGGESTIONS: Readonly<Record<Surface, CacheSuggestion>> = {
  code: {
    percent: 85,
    basis: "illustrative",
    gatewayRouted: true,
    source: "https://code.claude.com/docs/en/costs",
    note: "The docs' example /usage line reads '91% of input tokens from cache'. 85 is a chosen margin below that example, not a stated figure.",
  },
  cowork: {
    percent: 30,
    basis: "analogue",
    gatewayRouted: false,
    source: "https://claude.com/customers/dust",
    note: "An agent platform reported cache reads of 30% of input tokens before tuning and 65% after. The untuned 30 is used. Cowork is not routed through the gateway (G-R2).",
  },
  m365: {
    percent: 60,
    basis: "assumed",
    gatewayRouted: true,
    source: "https://claude.com/resources/articles/prompt-caching",
    note: "No published share for the Office add-ins. The source reports up to 90% cost reduction for a 100K-token cached document (2024 pricing).",
  },
  chat: {
    percent: 50,
    basis: "assumed",
    gatewayRouted: true,
    source: "https://claude.com/resources/articles/prompt-caching",
    note: "No published share for chat. The source reports a 53% cost reduction for a 10-turn conversation (2024 pricing).",
  },
  design: {
    percent: null,
    basis: "none",
    gatewayRouted: false,
    source: "",
    note: "Placeholder surface without a Foundry path.",
  },
};

export interface GroupCacheSuggestion {
  percent: number;
  // The surfaces that give the lowest value, and their evidence classes, so a
  // console shows where the number comes from and how strong it is.
  from: { surface: Surface; basis: CacheEvidence }[];
}

// The lowest suggestion among the enabled surfaces the gateway carries: a lower cache share gives
// a higher cost estimate, so a mixed group's budget errs on the safe side.
export function suggestCacheReadPercent(surfaces: readonly Surface[]): GroupCacheSuggestion | null {
  const known = [...new Set(surfaces)].filter((s) => CACHE_SUGGESTIONS[s].percent !== null && CACHE_SUGGESTIONS[s].gatewayRouted);
  if (known.length === 0) return null;
  const percent = Math.min(...known.map((s) => CACHE_SUGGESTIONS[s].percent as number));
  const from = known.filter((s) => CACHE_SUGGESTIONS[s].percent === percent).sort()
    .map((surface) => ({ surface, basis: CACHE_SUGGESTIONS[surface].basis }));
  return { percent, from };
}
