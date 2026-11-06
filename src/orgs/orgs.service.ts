import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../common/enums';
import { AuditService } from '../audit/audit.service';
import { assertWithinLimit } from '../billing/plans';
import { PrismaService } from '../prisma/prisma.service';
import { canAssignRole } from '../tenancy/roles';
import { TenantContext } from '../tenancy/tenant.guard';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, name: string) {
    const base = slugify(name) || 'org';
    const slug = `${base}-${randomBytes(3).toString('hex')}`;
    const org = await this.prisma.organization.create({
      data: { name, slug, memberships: { create: { userId, role: 'OWNER' } } },
    });
    await this.audit.record({ organizationId: org.id, actorId: userId, action: 'org.created' });
    return org;
  }

  members(tenant: TenantContext) {
    return this.prisma.membership.findMany({
      where: { organizationId: tenant.organizationId },
      select: { id: true, role: true, createdAt: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Returns the raw invite token exactly once; only its hash is stored. */
  async invite(tenant: TenantContext, actorId: string, email: string, role: Role) {
    if (!canAssignRole(tenant.role, role)) throw new ForbiddenException(`You cannot invite a ${role}`);

    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: tenant.organizationId } });
    const members = await this.prisma.membership.count({ where: { organizationId: org.id } });
    assertWithinLimit(org.plan, 'maxMembers', members);

    const normalized = email.toLowerCase();
    const existing = await this.prisma.membership.findFirst({
      where: { organizationId: org.id, user: { email: normalized } },
    });
    if (existing) throw new ConflictException('User is already a member');

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId: org.id,
        email: normalized,
        role,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedById: actorId,
      },
    });
    await this.audit.record({
      organizationId: org.id,
      actorId,
      action: 'member.invited',
      target: normalized,
      metadata: { role },
    });
    // In production, email the link instead of returning it.
    return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
  }

  async acceptInvite(userId: string, userEmail: string, token: string) {
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.acceptedAt) throw new GoneException('Invitation already used');
    if (inv.expiresAt < new Date()) throw new GoneException('Invitation expired');
    if (inv.email !== userEmail.toLowerCase()) {
      throw new ForbiddenException('This invitation was sent to a different email address');
    }

    await this.prisma.$transaction([
      this.prisma.membership.create({ data: { userId, organizationId: inv.organizationId, role: inv.role } }),
      this.prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    ]);
    await this.audit.record({ organizationId: inv.organizationId, actorId: userId, action: 'member.joined' });
    return { organizationId: inv.organizationId, role: inv.role };
  }

  async changeRole(tenant: TenantContext, actorId: string, membershipId: string, role: Role) {
    const target = await this.findMembership(tenant, membershipId);
    if (!canAssignRole(tenant.role, target.role) || !canAssignRole(tenant.role, role)) {
      throw new ForbiddenException('Insufficient role to make this change');
    }
    if (target.role === 'OWNER' && role !== 'OWNER') await this.assertNotLastOwner(tenant.organizationId);

    const updated = await this.prisma.membership.update({ where: { id: target.id }, data: { role } });
    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: 'member.role_changed',
      target: target.userId,
      metadata: { from: target.role, to: role },
    });
    return updated;
  }

  async removeMember(tenant: TenantContext, actorId: string, membershipId: string) {
    const target = await this.findMembership(tenant, membershipId);
    const isSelf = target.userId === actorId;
    if (!isSelf && !canAssignRole(tenant.role, target.role)) {
      throw new ForbiddenException('Insufficient role to remove this member');
    }
    if (target.role === 'OWNER') await this.assertNotLastOwner(tenant.organizationId);

    await this.prisma.membership.delete({ where: { id: target.id } });
    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: isSelf ? 'member.left' : 'member.removed',
      target: target.userId,
    });
  }

  private async findMembership(tenant: TenantContext, membershipId: string) {
    // Scoped by organizationId: a membership id from another tenant is simply "not found".
    const m = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId: tenant.organizationId },
    });
    if (!m) throw new NotFoundException('Member not found');
    return m;
  }

  private async assertNotLastOwner(organizationId: string) {
    const owners = await this.prisma.membership.count({ where: { organizationId, role: 'OWNER' } });
    if (owners <= 1) throw new BadRequestException('An organization must keep at least one owner');
  }
}
