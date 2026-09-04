import type { PricingTier, SubscriptionTier } from "../types/index.js";

export const RENDER_COST_CREDITS = 0.5;
export const FREE_TIER_INITIAL_CREDITS = 5;
export const FREE_TIER_MONTHLY_CREDITS = 5;

export const PRICING_TIERS: Record<SubscriptionTier, PricingTier> = {
  free: {
    name: "Free",
    priceMonthly: 0,
    creditsMonthly: FREE_TIER_MONTHLY_CREDITS,
    renders: Math.floor(FREE_TIER_MONTHLY_CREDITS / RENDER_COST_CREDITS),
    features: ["Basic renders", "Limited history"]
  },
  starter: {
    name: "Starter",
    priceMonthly: 9,
    creditsMonthly: 50,
    renders: 100,
    features: ["50 renders/month", "Full history", "Basic support"]
  },
  pro: {
    name: "Professional",
    priceMonthly: 29,
    creditsMonthly: 500,
    renders: 1000,
    features: ["500 renders/month", "Advanced features", "Priority support", "Batch API access"]
  },
  enterprise: {
    name: "Enterprise",
    priceMonthly: null,
    creditsMonthly: null,
    renders: "Unlimited",
    features: ["Custom limits", "Dedicated support", "Custom integration", "100+ renders/month"],
    contact: true
  }
};

export function getPricingTiers(): Record<SubscriptionTier, PricingTier> {
  return PRICING_TIERS;
}

export function getPricingSummary() {
  return {
    perRender: RENDER_COST_CREDITS,
    tiers: getPricingTiers()
  };
}
