import { BadRequestException, ConflictException, ForbiddenException, GoneException } from '@nestjs/common';
import { hashToken, OrgsService, slugify } from './orgs.service';

function setup() {
  const prisma: any = {
    organization: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'org1', ...data })),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org1', plan: 'FREE' }),
    },
    membership: {
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn().mockImplementation(({ data }) => data),
      delete: jest.fn(),
    },
    invitation: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'inv1', ...data })),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const audit = { record: jest.fn() };
  return { service: new OrgsService(prisma, audit as any), prisma, audit };
}

const admin = { organizationId: 'org1', role: 'ADMIN' as const };
const owner = { organizationId: 'org1', role: 'OWNER' as const };

describe('slugify', () => {
  it('produces URL-safe slugs, including from accented names', () => {
    expect(slugify('Müller & Söhne GmbH')).toBe('muller-sohne-gmbh');
    expect(slugify('  Công ty Huế  ')).toBe('cong-ty-hue');
  });
});

describe('OrgsService', () => {
  it('creates an org with the creator as OWNER and audits it', async () => {
    const { service, prisma, audit } = setup();
    const org = await service.create('u1', 'Acme GmbH');
    expect(org.slug).toMatch(/^acme-gmbh-[0-9a-f]{6}$/);
    expect(prisma.organization.create.mock.calls[0][0].data.memberships).toEqual({
      create: { userId: 'u1', role: 'OWNER' },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'org.created' }));
  });

  describe('invite', () => {
    it('stores only a hash of the token and returns the raw token once', async () => {
      const { service, prisma } = setup();
      const res = await service.invite(admin, 'u1', 'New@Example.com', 'MEMBER');
      const stored = prisma.invitation.create.mock.calls[0][0].data;
      expect(stored.email).toBe('new@example.com');
      expect(stored.tokenHash).toBe(hashToken(res.token));
      expect(stored.tokenHash).not.toBe(res.token);
      expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('prevents admins from inviting admins or owners', async () => {
      const { service } = setup();
      await expect(service.invite(admin, 'u1', 'a@b.co', 'ADMIN')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('enforces the plan member limit', async () => {
      const { service, prisma } = setup();
      prisma.membership.count.mockResolvedValue(3); // FREE allows 3
      await expect(service.invite(owner, 'u1', 'a@b.co', 'MEMBER')).rejects.toThrow(/Upgrade/);
    });

    it('rejects inviting an existing member', async () => {
      const { service, prisma } = setup();
      prisma.membership.findFirst.mockResolvedValue({ id: 'm1' });
      await expect(service.invite(owner, 'u1', 'a@b.co', 'MEMBER')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('acceptInvite', () => {
    const valid = () => ({
      id: 'inv1',
      organizationId: 'org1',
      email: 'a@b.co',
      role: 'MEMBER',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    it('creates the membership and marks the invite used', async () => {
      const { service, prisma } = setup();
      prisma.invitation.findUnique.mockResolvedValue(valid());
      await expect(service.acceptInvite('u2', 'A@B.co', 'tok')).resolves.toEqual({
        organizationId: 'org1',
        role: 'MEMBER',
      });
      expect(prisma.invitation.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashToken('tok') } });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('rejects expired, reused and misaddressed invites', async () => {
      const { service, prisma } = setup();
      prisma.invitation.findUnique.mockResolvedValueOnce({ ...valid(), expiresAt: new Date(Date.now() - 1) });
      await expect(service.acceptInvite('u2', 'a@b.co', 't')).rejects.toBeInstanceOf(GoneException);
      prisma.invitation.findUnique.mockResolvedValueOnce({ ...valid(), acceptedAt: new Date() });
      await expect(service.acceptInvite('u2', 'a@b.co', 't')).rejects.toBeInstanceOf(GoneException);
      prisma.invitation.findUnique.mockResolvedValueOnce(valid());
      await expect(service.acceptInvite('u2', 'other@b.co', 't')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('member management', () => {
    it('scopes membership lookups to the current tenant', async () => {
      const { service, prisma } = setup();
      await expect(service.removeMember(owner, 'u1', 'm-other-org')).rejects.toThrow('Member not found');
      expect(prisma.membership.findFirst).toHaveBeenCalledWith({
        where: { id: 'm-other-org', organizationId: 'org1' },
      });
    });

    it('never removes or demotes the last owner', async () => {
      const { service, prisma } = setup();
      prisma.membership.findFirst.mockResolvedValue({ id: 'm1', userId: 'u1', role: 'OWNER' });
      prisma.membership.count.mockResolvedValue(1);
      await expect(service.changeRole(owner, 'u1', 'm1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.removeMember(owner, 'u1', 'm1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admins cannot change other admins', async () => {
      const { service, prisma } = setup();
      prisma.membership.findFirst.mockResolvedValue({ id: 'm2', userId: 'u2', role: 'ADMIN' });
      await expect(service.changeRole(admin, 'u1', 'm2', 'MEMBER')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('any member can leave on their own', async () => {
      const { service, prisma, audit } = setup();
      prisma.membership.findFirst.mockResolvedValue({ id: 'm3', userId: 'u3', role: 'MEMBER' });
      await service.removeMember({ organizationId: 'org1', role: 'MEMBER' }, 'u3', 'm3');
      expect(prisma.membership.delete).toHaveBeenCalledWith({ where: { id: 'm3' } });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.left' }));
    });
  });
});
