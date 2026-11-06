import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../tenancy/tenant.guard';
import { planForSubscriptionStatus } from './plans';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly stripe: Stripe,
  ) {}

  /** Creates a Stripe Checkout session for the PRO plan and returns its URL. */
  async createCheckout(tenant: TenantContext, actorEmail: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: tenant.organizationId } });
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: this.config.getOrThrow<string>('STRIPE_PRICE_PRO'), quantity: 1 }],
      customer: org.stripeCustomerId ?? undefined,
      customer_email: org.stripeCustomerId ? undefined : actorEmail,
      client_reference_id: org.id,
      subscription_data: { metadata: { organizationId: org.id } },
      success_url: `${appUrl}/billing?status=success`,
      cancel_url: `${appUrl}/billing?status=cancelled`,
    });
    return { url: session.url };
  }

  /** Customer portal for managing payment methods, invoices and cancellation. */
  async createPortal(tenant: TenantContext) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: tenant.organizationId } });
    if (!org.stripeCustomerId) throw new BadRequestException('No billing account yet. Upgrade first.');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${this.config.get<string>('APP_URL', 'http://localhost:3000')}/billing`,
    });
    return { url: session.url };
  }

  /** Verifies the Stripe signature, then applies the event exactly once. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ received: true; duplicate?: true }> {
    if (!signature) throw new BadRequestException('Missing Stripe-Signature header');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET'),
      );
    } catch {
      throw new BadRequestException('Invalid webhook signature');
    }

    // Stripe retries deliveries; recording the event id makes processing idempotent.
    const seen = await this.prisma.processedWebhookEvent.findUnique({ where: { id: event.id } });
    if (seen) return { received: true, duplicate: true };

    await this.apply(event);
    await this.prisma.processedWebhookEvent.create({ data: { id: event.id } });
    return { received: true };
  }

  async apply(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (!s.client_reference_id) return;
        await this.prisma.organization.update({
          where: { id: s.client_reference_id },
          data: {
            stripeCustomerId: typeof s.customer === 'string' ? s.customer : s.customer?.id,
            stripeSubscriptionId: typeof s.subscription === 'string' ? s.subscription : s.subscription?.id,
          },
        });
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const organizationId = sub.metadata?.organizationId;
        if (!organizationId) {
          this.logger.warn(`Subscription ${sub.id} has no organizationId metadata; ignoring`);
          return;
        }
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
        const plan = planForSubscriptionStatus(status);
        await this.prisma.organization.update({
          where: { id: organizationId },
          data: { plan, subscriptionStatus: status, stripeSubscriptionId: sub.id },
        });
        await this.audit.record({
          organizationId,
          action: 'billing.subscription_changed',
          metadata: { status, plan },
        });
        return;
      }
      default:
        this.logger.debug(`Ignoring Stripe event ${event.type}`);
    }
  }
}
