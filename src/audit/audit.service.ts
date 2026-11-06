import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  organizationId: string;
  actorId?: string | null;
  action: string;
  target?: string;
  metadata?: Prisma.InputJsonValue;
}

/** Append-only record of who did what in each organization. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: { ...entry, actorId: entry.actorId ?? null } });
    } catch (err) {
      // Auditing must never break the business action that triggered it.
      this.logger.error(`Failed to write audit log for ${entry.action}: ${err}`);
    }
  }

  list(organizationId: string, take = 50) {
    return this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
