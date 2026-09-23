import { describe, expect, it } from "vitest";
import Chargebee from "chargebee";
import { NAMESPACE_HEADER, createServer } from "@emulators/core";
import { DEFAULT_API_KEY, DEFAULT_CUSTOMER_ID, DEFAULT_PLAN_MONTHLY_PRICE_ID, chargebeePlugin } from "../index.js";

function createNamespacedClient(app: ReturnType<typeof createServer>["app"], namespace: string) {
  return new Chargebee({
    site: "localhost",
    apiKey: DEFAULT_API_KEY,
    protocol: "http",
    hostSuffix: "",
    port: 4314,
    httpClient: {
      makeApiRequest: (request: Request) => {
        request.headers.set(NAMESPACE_HEADER, namespace);
        return app.request(request);
      },
    },
  } as ConstructorParameters<typeof Chargebee>[0]);
}

describe("Chargebee emulator namespaces", () => {
  it("gives every namespace the seed and isolates what it creates", async () => {
    const { app, store } = createServer(chargebeePlugin, { port: 4314 });
    chargebeePlugin.seed!(store, "http://localhost:4314");
    const first = createNamespacedClient(app, "test-1");
    const second = createNamespacedClient(app, "test-2");

    const created = await first.customer.create({ company: "Acme", cf_companyId: "cmp-1" } as Record<string, unknown>);
    await first.subscription.importForItems(created.customer.id, {
      subscription_items: [{ item_price_id: DEFAULT_PLAN_MONTHLY_PRICE_ID }],
      auto_collection: "off",
      create_current_term_invoice: false,
    } as Parameters<typeof first.subscription.importForItems>[1]);

    expect((await first.customer.list({ cf_companyId: { is: "cmp-1" } } as never)).list).toHaveLength(1);
    expect((await second.customer.list({ cf_companyId: { is: "cmp-1" } } as never)).list).toHaveLength(0);
    await expect(second.customer.retrieve(created.customer.id)).rejects.toMatchObject({ http_status_code: 404 });

    const seededForSecond = await second.customer.retrieve(DEFAULT_CUSTOMER_ID);
    expect(seededForSecond.customer.id).toBe(DEFAULT_CUSTOMER_ID);
    expect((await second.subscription.list({ customer_id: { is: DEFAULT_CUSTOMER_ID } })).list).toHaveLength(1);
    expect((await first.subscription.list({ limit: 100 })).list).toHaveLength(2);
    expect((await second.subscription.list({ limit: 100 })).list).toHaveLength(1);
  });

  it("stays the same resource between a create and the following retrieve", async () => {
    const { app, store } = createServer(chargebeePlugin, { port: 4314 });
    chargebeePlugin.seed!(store, "http://localhost:4314");
    const client = createNamespacedClient(app, "test-3");

    const created = await client.customer.create({
      company: "Stable Corp",
      locale: "fr",
      cf_companyId: "cmp-3",
      cf_grade: "C",
      auto_collection: "off",
    } as Record<string, unknown>);
    const retrieved = await client.customer.retrieve(created.customer.id);

    expect(retrieved.customer).toEqual(created.customer);
    expect((retrieved.customer as Record<string, unknown>).cf_grade).toBe("C");
  });
});
