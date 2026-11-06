import { Role } from '../common/enums';

/** Higher number = more privileges. A role satisfies any requirement at or below its rank. */
export const ROLE_RANK: Record<Role, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** An actor may only grant or change roles strictly below their own (owners may grant anything). */
export function canAssignRole(actor: Role, target: Role): boolean {
  return actor === 'OWNER' || ROLE_RANK[actor] > ROLE_RANK[target];
}
