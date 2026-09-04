export type SubscriptionTier = "free" | "starter" | "pro" | "enterprise";

export type TransactionType =
  | "charge"
  | "purchase"
  | "refund"
  | "bonus"
  | "subscription";

export interface PricingTier {
  name: string;
  priceMonthly: number | null;
  creditsMonthly: number | null;
  renders: number | "Unlimited";
  features: string[];
  contact?: boolean;
}

export interface CreditBalance {
  userId: string;
  balanceCredits: number;
  subscriptionTier: SubscriptionTier;
  lifetimePurchased: number;
  updatedAt?: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  usedToday: number;
  dailyLimit: number;
  reason?: string;
}

export interface CreditTransaction {
  userId: string;
  amount: number;
  transactionType: TransactionType;
  reason: string;
  paymentIntentId?: string | null;
  renderRequestId?: string | null;
  balanceBefore: number;
  balanceAfter: number;
}
