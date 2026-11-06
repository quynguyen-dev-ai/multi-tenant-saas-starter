import { Controller, Get, Headers, HttpCode, Module, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { CurrentUser, JwtGuard, JwtPayload } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { RequireRole, Tenant, TenantContext, TenantGuard } from '../tenancy/tenant.guard';
import { BillingService } from './billing.service';
import { PLAN_LIMITS } from './plans';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiBearerAuth()
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(JwtGuard, TenantGuard)
  async status(@Tenant() tenant: TenantContext) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: tenant.organizationId },
      include: { _count: { select: { memberships: true, projects: true } } },
    });
    const limits = PLAN_LIMITS[org.plan];
    return {
      plan: org.plan,
      subscriptionStatus: org.subscriptionStatus,
      usage: { members: org._count.memberships, projects: org._count.projects },
      limits: {
        members: limits.maxMembers,
        projects: Number.isFinite(limits.maxProjects) ? limits.maxProjects : null,
      },
    };
  }

  @Post('checkout')
  @ApiBearerAuth()
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(JwtGuard, TenantGuard)
  @RequireRole('OWNER')
  checkout(@Tenant() tenant: TenantContext, @CurrentUser() user: JwtPayload) {
    return this.billing.createCheckout(tenant, user.email);
  }

  @Post('portal')
  @ApiBearerAuth()
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(JwtGuard, TenantGuard)
  @RequireRole('OWNER')
  portal(@Tenant() tenant: TenantContext) {
    return this.billing.createPortal(tenant);
  }

  @Post('webhook')
  @HttpCode(200)
  @SkipThrottle()
  @ApiExcludeEndpoint()
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    return this.billing.handleWebhook(req.rawBody ?? Buffer.alloc(0), signature);
  }
}

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    TenantGuard,
    {
      provide: Stripe,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Stripe(config.get<string>('STRIPE_SECRET_KEY', 'sk_test_placeholder')),
    },
  ],
})
export class BillingModule {}
