import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtGuard, JwtPayload } from '../auth/auth.module';
import { assertWithinLimit } from '../billing/plans';
import { PrismaService } from '../prisma/prisma.service';
import { RequireRole, Tenant, TenantContext, TenantGuard } from '../tenancy/tenant.guard';

class CreateProjectDto {
  @ApiProperty({ example: 'Website relaunch' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

/**
 * Reference implementation of a tenant-owned resource. Every query includes
 * `organizationId` from the verified tenant context, never from the client.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext) {
    return this.prisma.project.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(tenant: TenantContext, actorId: string, name: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: tenant.organizationId } });
    const count = await this.prisma.project.count({ where: { organizationId: org.id } });
    assertWithinLimit(org.plan, 'maxProjects', count);

    const project = await this.prisma.project.create({
      data: { organizationId: org.id, name, createdById: actorId },
    });
    await this.audit.record({ organizationId: org.id, actorId, action: 'project.created', target: project.id });
    return project;
  }

  async remove(tenant: TenantContext, actorId: string, id: string) {
    const { count } = await this.prisma.project.deleteMany({ where: { id, organizationId: tenant.organizationId } });
    if (count === 0) throw new NotFoundException('Project not found');
    await this.audit.record({ organizationId: tenant.organizationId, actorId, action: 'project.deleted', target: id });
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtGuard, TenantGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Tenant() tenant: TenantContext) {
    return this.projects.list(tenant);
  }

  @Post()
  create(@Tenant() tenant: TenantContext, @CurrentUser() user: JwtPayload, @Body() dto: CreateProjectDto) {
    return this.projects.create(tenant, user.sub, dto.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireRole('ADMIN')
  remove(@Tenant() tenant: TenantContext, @CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.projects.remove(tenant, user.sub, id);
  }
}

@Module({ controllers: [ProjectsController], providers: [ProjectsService, TenantGuard] })
export class ProjectsModule {}
