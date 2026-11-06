import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canAssignRole, hasRole } from './roles';
import { TenantGuard } from './tenant.guard';

describe('role hierarchy', () => {
  it('higher roles satisfy lower requirements', () => {
    expect(hasRole('OWNER', 'ADMIN')).toBe(true);
    expect(hasRole('ADMIN', 'ADMIN')).toBe(true);
    expect(hasRole('MEMBER', 'ADMIN')).toBe(false);
  });

  it('admins can only manage roles below their own; owners can manage all', () => {
    expect(canAssignRole('ADMIN', 'MEMBER')).toBe(true);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('OWNER', 'OWNER')).toBe(true);
    expect(canAssignRole('MEMBER', 'MEMBER')).toBe(false);
  });
});

describe('TenantGuard', () => {
  function setup(membership: { role: string } | null, requiredRole?: string) {
    const prisma = { membership: { findUnique: jest.fn().mockResolvedValue(membership) } };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(requiredRole) } as unknown as Reflector;
    const req: any = { headers: { 'x-org-id': 'org1' }, user: { sub: 'u1' } };
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    };
    return { guard: new TenantGuard(prisma as any, reflector), prisma, req, ctx };
  }

  it('attaches the tenant context for members', async () => {
    const { guard, req, ctx, prisma } = setup({ role: 'MEMBER' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.tenant).toEqual({ organizationId: 'org1', role: 'MEMBER' });
    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: 'u1', organizationId: 'org1' } },
    });
  });

  it('rejects non-members of the organization', async () => {
    const { guard, ctx } = setup(null);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('enforces the minimum role', async () => {
    const { guard, ctx } = setup({ role: 'MEMBER' }, 'ADMIN');
    await expect(guard.canActivate(ctx)).rejects.toThrow('Requires ADMIN role');
  });

  it('requires the X-Org-Id header', async () => {
    const { guard, ctx, req } = setup({ role: 'OWNER' });
    delete req.headers['x-org-id'];
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(BadRequestException);
  });
});
