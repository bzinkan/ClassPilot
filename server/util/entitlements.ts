import type { School } from "@shared/schema";

export const PLAN_TIER_ORDER = ["trial", "basic", "pro", "enterprise"] as const;
export const PLAN_STATUS_VALUES = ["active", "past_due", "canceled"] as const;

export type PlanTier = (typeof PLAN_TIER_ORDER)[number];
export type PlanStatus = (typeof PLAN_STATUS_VALUES)[number];

export function isSchoolEntitled(school?: School | null): boolean {
  if (!school || school.isActive !== true) {
    return false;
  }

  if (school.activeUntil) {
    const activeUntil = new Date(school.activeUntil);
    if (Number.isFinite(activeUntil.getTime()) && Date.now() > activeUntil.getTime()) {
      return false;
    }
  }

  if (school.planStatus === "past_due" || school.planStatus === "canceled") {
    return false;
  }

  return true;
}

export function assertTierAtLeast(
  school: Pick<School, "planTier"> | null | undefined,
  requiredTier: PlanTier
): boolean {
  const schoolTier = school?.planTier ?? "trial";
  const schoolIndex = PLAN_TIER_ORDER.indexOf(schoolTier as PlanTier);
  const requiredIndex = PLAN_TIER_ORDER.indexOf(requiredTier);
  if (schoolIndex === -1 || requiredIndex === -1) {
    return false;
  }
  return schoolIndex >= requiredIndex;
}
