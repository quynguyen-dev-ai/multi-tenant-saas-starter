import { BadRequestException, ForbiddenException } from '@nestjs/common';
import Stripe from 'stripe';
import { BillingService } from './billing.service';
import { assertWithinLimit, planForSubscriptionStatus } from './plans';

const SECRET = 'whsec_test_secret';
const stripe = new Stripe('sk_test_dummy');

function signed(event: object) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { body: Buffer.from(payload), signature };
}

function setup() {
  const prisma: any = {
    organization: { update: jest.fn() },
    processedWebhookEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
  };
  const audit = { record: jest.fn() };
  const config: any = { getOrThrow: () => SECRET, get: (_: string, d: string) => d };
  return { service: new BillingService(prisma, audit as any, config, stripe), prisma, audit };
}

const subscriptionEvent = (type: string, status: string, id = 'evt_1') => ({
  id,
  object: 'event',
  type,
  data: { object: { id: 'sub_1', object: 'subscription', status, metadata: { organizationId: 'org1' } } },
});

describe('plan rules', () => {
  it('maps subscription status to plan', () => {
    expect(planForSubscriptionStatus('active')).toBe('PRO');
    expect(planForSubscriptionStatus('trialing')).toBe('PRO');
    expect(planForSubscriptionStatus('past_due')).toBe('PRO');
    expect(planForSubscriptionStatus('canceled')).toBe('FREE');
    expect(planForSubscriptionStatus('unpaid')).toBe('FREE');
  });

  it('blocks creation at the limit with an upgrade hint', () => {
    expect(() => assertWithinLimit('FREE', 'maxProjects', 2)).not.toThrow();
    expect(() => assertWithinLimit('FREE', 'maxProjects', 3)).toThrow(ForbiddenException);
    expect(() => assertWithinLimit('PRO', 'maxProjects', 10_000)).not.toThrow();
  });
});

describe('Stripe webhook', () => {
  it('rejects missing or forged signatures', async () => {
    const { service } = setup();
    const { body } = signed(subscriptionEvent('customer.subscription.updated', 'active'));
    await expect(service.handleWebhook(body, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.handleWebhook(body, 't=1,v1=forged')).rejects.toThrow('Invalid webhook signature');
  });

  it('upgrades the organization when a subscription becomes active', async () => {
    const { service, prisma, audit } = setup();
    const { body, signature } = signed(subscriptionEvent('customer.subscription.updated', 'active'));
    await expect(service.handleWebhook(body, signature)).resolves.toEqual({ received: true });
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org1' },
      data: { plan: 'PRO', subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1' },
    });
    expect(audit.record).toHaveBeenCalled();
    expect(prisma.processedWebhookEvent.create).toHaveBeenCalledWith({ data: { id: 'evt_1' } });
  });

  it('downgrades to FREE when the subscription is deleted', async () => {
    const { service, prisma } = setup();
    const { body, signature } = signed(subscriptionEvent('customer.subscription.deleted', 'active', 'evt_2'));
    await service.handleWebhook(body, signature);
    expect(prisma.organization.update.mock.calls[0][0].data.plan).toBe('FREE');
  });

  it('is idempotent across Stripe retries', async () => {
    const { service, prisma } = setup();
    prisma.processedWebhookEvent.findUnique.mockResolvedValue({ id: 'evt_1' });
    const { body, signature } = signed(subscriptionEvent('customer.subscription.updated', 'active'));
    await expect(service.handleWebhook(body, signature)).resolves.toEqual({ received: true, duplicate: true });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('links the Stripe customer after checkout', async () => {
    const { service, prisma } = setup();
    const { body, signature } = signed({
      id: 'evt_3',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', client_reference_id: 'org1', customer: 'cus_1', subscription: 'sub_1' } },
    });
    await service.handleWebhook(body, signature);
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org1' },
      data: { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
    });
  });
});
