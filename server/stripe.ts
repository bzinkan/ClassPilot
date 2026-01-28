import Stripe from "stripe";
import { db } from "./db";
import { schools } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("STRIPE_SECRET_KEY not set — Stripe features disabled");
}

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const BASE_PRICE_CENTS = 50000; // $500
const PER_STUDENT_CENTS = 200; // $2

function calculateAmount(studentCount: number, skipTrial: boolean): number {
  const annual = BASE_PRICE_CENTS + studentCount * PER_STUDENT_CENTS;
  if (skipTrial) {
    // 2 months free = subtract 2/12 of annual
    return Math.round(annual - annual / 6);
  }
  return annual;
}

/**
 * Create a Stripe Checkout Session for self-service payment
 */
export async function createCheckoutSession(opts: {
  schoolId: string;
  schoolName: string;
  studentCount: number;
  skipTrial: boolean;
  billingEmail: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  if (!stripe) throw new Error("Stripe not configured");

  const amount = calculateAmount(opts.studentCount, opts.skipTrial);
  const description = opts.skipTrial
    ? `ClassPilot Annual Plan — ${opts.studentCount} students (2 months free)`
    : `ClassPilot Annual Plan — ${opts.studentCount} students`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: opts.billingEmail,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amount,
          product_data: {
            name: "ClassPilot Annual Plan",
            description,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      schoolId: opts.schoolId,
      studentCount: String(opts.studentCount),
      skipTrial: String(opts.skipTrial),
    },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });

  return session.url!;
}

/**
 * Create and send a custom Stripe Invoice from super admin
 */
export async function createCustomInvoice(opts: {
  schoolId: string;
  schoolName: string;
  billingEmail: string;
  stripeCustomerId?: string | null;
  studentCount: number;
  basePrice: number; // in dollars
  perStudentPrice: number; // in dollars
  description?: string;
  daysUntilDue?: number;
}): Promise<{ invoiceId: string; invoiceUrl: string; customerId: string }> {
  if (!stripe) throw new Error("Stripe not configured");

  // Create or reuse Stripe customer
  let customerId = opts.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: opts.billingEmail,
      name: opts.schoolName,
      metadata: { schoolId: opts.schoolId },
    });
    customerId = customer.id;

    // Save customer ID to school
    await db
      .update(schools)
      .set({ stripeCustomerId: customerId })
      .where(eq(schools.id, opts.schoolId));
  }

  const baseCents = Math.round(opts.basePrice * 100);
  const perStudentCents = Math.round(opts.perStudentPrice * 100);
  const totalStudentCents = perStudentCents * opts.studentCount;

  // Create invoice
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: opts.daysUntilDue ?? 30,
    metadata: {
      schoolId: opts.schoolId,
      studentCount: String(opts.studentCount),
    },
    custom_fields: [
      { name: "School", value: opts.schoolName },
    ],
  });

  // Add line items
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: invoice.id,
    amount: baseCents,
    currency: "usd",
    description: opts.description || "ClassPilot Annual Platform Fee",
  });

  if (opts.studentCount > 0 && perStudentCents > 0) {
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: totalStudentCents,
      currency: "usd",
      description: `Per-student license (${opts.studentCount} students × $${opts.perStudentPrice}/student)`,
    });
  }

  // Finalize and send
  const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(invoice.id);

  return {
    invoiceId: invoice.id,
    invoiceUrl: finalizedInvoice.hosted_invoice_url || "",
    customerId,
  };
}

/**
 * Handle Stripe webhook events
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const schoolId = session.metadata?.schoolId;
      const studentCount = parseInt(session.metadata?.studentCount || "0", 10);
      const amountPaid = session.amount_total || 0;

      if (!schoolId) {
        console.error("Webhook: checkout.session.completed missing schoolId metadata");
        return;
      }

      const now = new Date();
      const activeUntil = new Date(now);
      activeUntil.setFullYear(activeUntil.getFullYear() + 1);

      await db
        .update(schools)
        .set({
          status: "active",
          planTier: "basic",
          planStatus: "active",
          activeUntil,
          maxLicenses: studentCount,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: now,
          totalPaid: sql`COALESCE(${schools.totalPaid}, 0) + ${amountPaid}`,
        })
        .where(eq(schools.id, schoolId));

      console.log(`Checkout completed for school ${schoolId}: $${(amountPaid / 100).toFixed(2)}, ${studentCount} students`);
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const schoolId = invoice.metadata?.schoolId;
      const studentCount = parseInt(invoice.metadata?.studentCount || "0", 10);
      const amountPaid = invoice.amount_paid || 0;

      if (!schoolId) {
        console.error("Webhook: invoice.paid missing schoolId metadata");
        return;
      }

      const now = new Date();
      const activeUntil = new Date(now);
      activeUntil.setFullYear(activeUntil.getFullYear() + 1);

      await db
        .update(schools)
        .set({
          status: "active",
          planTier: "basic",
          planStatus: "active",
          activeUntil,
          maxLicenses: studentCount,
          stripeSubscriptionId: invoice.id,
          lastPaymentAmount: amountPaid,
          lastPaymentDate: now,
          totalPaid: sql`COALESCE(${schools.totalPaid}, 0) + ${amountPaid}`,
        })
        .where(eq(schools.id, schoolId));

      console.log(`Invoice paid for school ${schoolId}: $${(amountPaid / 100).toFixed(2)}, ${studentCount} students`);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const schoolId = invoice.metadata?.schoolId;

      if (!schoolId) {
        console.error("Webhook: invoice.payment_failed missing schoolId metadata");
        return;
      }

      await db
        .update(schools)
        .set({ planStatus: "past_due" })
        .where(eq(schools.id, schoolId));

      console.log(`Payment failed for school ${schoolId}`);
      break;
    }

    default:
      // Unhandled event type
      break;
  }
}

/**
 * Verify Stripe webhook signature
 */
export function constructWebhookEvent(
  payload: Buffer,
  signature: string,
  webhookSecret: string,
): Stripe.Event {
  if (!stripe) throw new Error("Stripe not configured");
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}
