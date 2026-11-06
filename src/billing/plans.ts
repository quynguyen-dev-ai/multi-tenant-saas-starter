import { ForbiddenException } from '@nestjs/common';
import { Plan } from '../common/enums';

export interface PlanLimits {
  maxMembers: number;
  maxProjects: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: { maxMembers: 3, maxProjects: 3 },
  PRO: { maxMembers: 50, maxProjects: Number.POSITIVE_INFINITY },
};

export type LimitedResource = keyof PlanLimits;

/** Throws a 403 with an upgrade hint when adding one more `resource` would exceed the plan. */
export function assertWithinLimit(plan: Plan, resource: LimitedResource, currentCount: number): void {
  const limit = PLAN_LIMITS[plan][resource];
  if (currentCount >= limit) {
    throw new ForbiddenException({
      code: 'PLAN_LIMIT_REACHED',
      message: `Your ${plan} plan allows ${limit} ${resource === 'maxMembers' ? 'members' : 'projects'}. Upgrade to add more.`,
      plan,
      limit,
    });
  }
}

/** Maps a Stripe subscription status to the plan the org should be on. */
export function planForSubscriptionStatus(status: string): Plan {
  // past_due keeps access during Stripe's retry window; everything else falls back to FREE.
  return status === 'active' || status === 'trialing' || status === 'past_due' ? 'PRO' : 'FREE';
}
