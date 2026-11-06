import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../common/enums';
import { PrismaService } from '../prisma/prisma.service';
import { hasRole } from './roles';

export interface TenantContext {
  organizationId: string;
  role: Role;
}

const MIN_ROLE = 'tenancy:minRole';

/** Require at least this role in the current organization. */
export const RequireRole = (role: Role) => SetMetadata(MIN_ROLE, role);

/**
 * Resolves the organization from the `X-Org-Id` header and verifies the
 * authenticated user is a member. Runs after JwtGuard. Because every tenant
 * route goes through this guard and services always filter by
 * `tenant.organizationId`, one tenant can never read another tenant's data
 * by guessing ids.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const orgId = req.headers['x-org-id'];
    if (typeof orgId !== 'string' || !orgId) throw new BadRequestException('Missing X-Org-Id header');

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.user.sub, organizationId: orgId } },
    });
    // 403 rather than 404 for both "no such org" and "not a member": don't reveal which orgs exist.
    if (!membership) throw new ForbiddenException('Not a member of this organization');

    const required = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && !hasRole(membership.role, required)) {
      throw new ForbiddenException(`Requires ${required} role`);
    }

    req.tenant = { organizationId: orgId, role: membership.role } satisfies TenantContext;
    return true;
  }
}

export const Tenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext => ctx.switchToHttp().getRequest().tenant,
);
