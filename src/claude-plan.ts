/**
 * Human plan name for a Claude OAuth login.
 *
 * Anthropic renamed its plans on 2026-10-30: "Max 5x" → "Max", "Max 20x" →
 * "Ultra". Credentials still carry the old internal tier ids
 * (e.g. `default_claude_max_20x`), so map those to the current names.
 */
export function claudePlanName(oauth: Record<string, unknown> | undefined): string {
  if (!oauth) return "unknown";
  const rawTier = oauth["rateLimitTier"] ?? oauth["rateLimitTiers"] ?? "";
  const tier = typeof rawTier === "string" ? rawTier.toLowerCase() : "";
  const rawSub = oauth["subscriptionType"];
  const sub = typeof rawSub === "string" && rawSub ? rawSub.toLowerCase() : "unknown";

  if (tier.includes("ultra") || tier.includes("20x") || sub === "ultra") return "Ultra";
  if (tier.includes("5x") || sub === "max") return "Max";
  if (sub === "pro") return "Pro";
  if (sub === "team") return "Team";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}
