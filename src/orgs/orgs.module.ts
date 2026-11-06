import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Role } from '../common/enums';
import { IsEmail, IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, JwtGuard, JwtPayload } from '../auth/auth.module';
import { RequireRole, Tenant, TenantContext, TenantGuard } from '../tenancy/tenant.guard';
import { OrgsService } from './orgs.service';

class CreateOrgDto {
  @ApiProperty({ example: 'Acme GmbH' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;
}

class InviteDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty({ enum: Role, default: Role.MEMBER })
  @IsEnum(Role)
  role: Role = Role.MEMBER;
}

class ChangeRoleDto {
  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role: Role;
}

class AcceptInviteDto {
  @ApiProperty()
  @IsString()
  token: string;
}

@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrgDto) {
    return this.orgs.create(user.sub, dto.name);
  }

  @Post('invitations/accept')
  accept(@CurrentUser() user: JwtPayload, @Body() dto: AcceptInviteDto) {
    return this.orgs.acceptInvite(user.sub, user.email, dto.token);
  }
}

/** Routes that act inside the organization selected by the X-Org-Id header. */
@ApiTags('organization members')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtGuard, TenantGuard)
@Controller('org')
export class CurrentOrgController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly audit: AuditService,
  ) {}

  @Get('members')
  members(@Tenant() tenant: TenantContext) {
    return this.orgs.members(tenant);
  }

  @Post('invitations')
  @RequireRole('ADMIN')
  invite(@Tenant() tenant: TenantContext, @CurrentUser() user: JwtPayload, @Body() dto: InviteDto) {
    return this.orgs.invite(tenant, user.sub, dto.email, dto.role);
  }

  @Patch('members/:id')
  @RequireRole('ADMIN')
  changeRole(
    @Tenant() tenant: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.orgs.changeRole(tenant, user.sub, id, dto.role);
  }

  @Delete('members/:id')
  @HttpCode(204)
  remove(@Tenant() tenant: TenantContext, @CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.orgs.removeMember(tenant, user.sub, id);
  }

  @Get('audit-log')
  @RequireRole('ADMIN')
  auditLog(@Tenant() tenant: TenantContext, @Query('take') take?: string) {
    return this.audit.list(tenant.organizationId, take ? Number(take) : undefined);
  }
}

@Module({
  controllers: [OrgsController, CurrentOrgController],
  providers: [OrgsService, TenantGuard],
  exports: [TenantGuard],
})
export class OrgsModule {}
