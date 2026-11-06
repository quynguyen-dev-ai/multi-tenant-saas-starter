/**
 * Domain enums, mirrored from prisma/schema.prisma. Keeping them here means
 * business rules (roles, plans) don't depend on generated database code and
 * can be unit-tested in isolation. The string values must match the schema.
 */
export const Role = { OWNER: 'OWNER', ADMIN: 'ADMIN', MEMBER: 'MEMBER' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Plan = { FREE: 'FREE', PRO: 'PRO' } as const;
export type Plan = (typeof Plan)[keyof typeof Plan];
