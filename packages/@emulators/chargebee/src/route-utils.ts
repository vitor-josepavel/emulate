import type { AppEnv, Context, Handler, Hono, WebhookDispatcher } from "@emulators/core";
import type { ChargeRequest, ItemRequest } from "./billing.js";
import type {
  ChargebeeApiKey,
  ChargebeeCoupon,
  ChargebeeCreditNote,
  ChargebeeCustomer,
  ChargebeeHostedPage,
  ChargebeeInvoice,
  ChargebeeItem,
  ChargebeeItemFamily,
  ChargebeeItemPrice,
  ChargebeePaymentSource,
  ChargebeePortalSession,
  ChargebeeSubscription,
  ChargebeeTransaction,
  SubscriptionDiscount,
} from "./entities.js";
import type { ChargebeeCtx } from "./events.js";
import {
  ChargebeeApiError,
  authenticate,
  columnar,
  notFoundError,
  num,
  paramError,
  sendApiError,
  type Body,
} from "./helpers.js";
import { prefixedId } from "./ids.js";
import type { ChargebeeStore } from "./store.js";

export interface ChargebeeRouteContext {
  app: Hono<AppEnv>;
  cs: ChargebeeStore;
  ctx: ChargebeeCtx;
  baseUrl: string;
  webhooks: WebhookDispatcher;
}

export type ApiHandler = (c: Context<AppEnv>, key: ChargebeeApiKey) => Promise<Response> | Response;

export function api(cs: ChargebeeStore, handler: ApiHandler): Handler<AppEnv> {
  return async (c) => {
    const key = authenticate(c, cs);
    if (key instanceof Response) return key;
    try {
      return await handler(c, key);
    } catch (error) {
      if (error instanceof ChargebeeApiError) return sendApiError(c, error);
      throw error;
    }
  };
}

export function guard<T>(fn: () => T, c: Context<AppEnv>): T | Response {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ChargebeeApiError) return sendApiError(c, error);
    throw error;
  }
}

function live<T extends object>(entity: T | undefined): T {
  if (!entity || (entity as { deleted?: boolean }).deleted) throw notFoundError();
  return entity;
}

export function findCustomer(cs: ChargebeeStore, id: string): ChargebeeCustomer {
  return live(cs.customers.findOneBy("cb_id", id));
}

export function findSubscription(cs: ChargebeeStore, id: string): ChargebeeSubscription {
  return live(cs.subscriptions.findOneBy("cb_id", id));
}

export function findInvoice(cs: ChargebeeStore, id: string): ChargebeeInvoice {
  return live(cs.invoices.findOneBy("cb_id", id));
}

export function findItemFamily(cs: ChargebeeStore, id: string): ChargebeeItemFamily {
  const family = cs.itemFamilies.findOneBy("cb_id", id);
  if (!family || family.status === "deleted") throw notFoundError();
  return family;
}

export function findItem(cs: ChargebeeStore, id: string): ChargebeeItem {
  const item = cs.items.findOneBy("cb_id", id);
  if (!item || item.status === "deleted") throw notFoundError();
  return item;
}

export function findItemPrice(cs: ChargebeeStore, id: string): ChargebeeItemPrice {
  const price = cs.itemPrices.findOneBy("cb_id", id);
  if (!price || price.status === "deleted") throw notFoundError();
  return price;
}

export function findCoupon(cs: ChargebeeStore, id: string): ChargebeeCoupon {
  const coupon = cs.coupons.findOneBy("cb_id", id);
  if (!coupon || coupon.status === "deleted") throw notFoundError();
  return coupon;
}

export function findPaymentSource(cs: ChargebeeStore, id: string): ChargebeePaymentSource {
  return live(cs.paymentSources.findOneBy("cb_id", id));
}

export function findTransaction(cs: ChargebeeStore, id: string): ChargebeeTransaction {
  return live(cs.transactions.findOneBy("cb_id", id));
}

export function findCreditNote(cs: ChargebeeStore, id: string): ChargebeeCreditNote {
  return live(cs.creditNotes.findOneBy("cb_id", id));
}

export function findHostedPage(cs: ChargebeeStore, id: string): ChargebeeHostedPage {
  return live(cs.hostedPages.findOneBy("cb_id", id));
}

export function findPortalSession(cs: ChargebeeStore, id: string): ChargebeePortalSession {
  return live(cs.portalSessions.findOneBy("cb_id", id));
}

export function parseItemRequests(body: Body, key = "subscription_items"): ItemRequest[] {
  return columnar(body[key])
    .filter((row) => row.item_price_id)
    .map((row) => ({
      item_price_id: row.item_price_id,
      quantity: num(row.quantity),
      unit_price: num(row.unit_price),
    }));
}

export function parseCharges(body: Body): ChargeRequest[] {
  return columnar(body.charges)
    .filter((row) => num(row.amount) !== undefined)
    .map((row) => ({
      amount: num(row.amount)!,
      description: row.description ?? "Charge",
    }));
}

export function nested(body: Body, key: string): Body {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}

const DISCOUNT_APPLY_ON = new Set(["invoice_amount", "specific_item_price"]);
const DISCOUNT_DURATIONS = new Set(["one_time", "forever", "limited_period"]);

/** Ad-hoc `discounts[...]` rows sent alongside a subscription. They are recorded on the subscription, not applied to invoices. */
export function parseDiscounts(cs: ChargebeeStore, body: Body, now: number): SubscriptionDiscount[] {
  return columnar(body.discounts).map((row, index) => {
    const applyOn = row.apply_on ?? "invoice_amount";
    if (!DISCOUNT_APPLY_ON.has(applyOn)) throw paramError(`discounts[apply_on][${index}]`, "is not a valid value");
    const durationType = row.duration_type ?? "forever";
    if (!DISCOUNT_DURATIONS.has(durationType))
      throw paramError(`discounts[duration_type][${index}]`, "is not a valid value");
    const percentage = num(row.percentage);
    const amount = num(row.amount);
    const quantity = num(row.quantity);
    if (percentage === undefined && amount === undefined && quantity === undefined)
      throw paramError(`discounts[percentage][${index}]`, "cannot be blank");
    if (applyOn === "specific_item_price") {
      if (!row.item_price_id) throw paramError(`discounts[item_price_id][${index}]`, "cannot be blank");
      if (!cs.itemPrices.findOneBy("cb_id", row.item_price_id))
        throw paramError(`discounts[item_price_id][${index}]`, `${row.item_price_id} is not a valid item price id`);
    }
    return {
      id: prefixedId("di", 12),
      invoice_name: row.invoice_name ?? null,
      type: percentage !== undefined ? "percentage" : "fixed_amount",
      percentage: percentage ?? null,
      amount: amount ?? null,
      currency_code: amount !== undefined ? (row.currency_code ?? null) : null,
      duration_type: durationType as SubscriptionDiscount["duration_type"],
      period: num(row.period) ?? null,
      period_unit: (row.period_unit as SubscriptionDiscount["period_unit"]) ?? null,
      included_in_mrr: row.included_in_mrr === "true",
      apply_on: applyOn as SubscriptionDiscount["apply_on"],
      item_price_id: applyOn === "specific_item_price" ? row.item_price_id : null,
      quantity: quantity ?? null,
      created_at: now,
      apply_till: null,
      applied_count: 0,
      coupon_id: null,
    };
  });
}
