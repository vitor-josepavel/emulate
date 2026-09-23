import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, type Entity } from "../store.js";
import { NAMESPACE_HEADER, currentNamespace, runInNamespace } from "../namespace.js";
import { createServer } from "../server.js";
import { WebhookDispatcher } from "../webhooks.js";
import type { ServicePlugin } from "../plugin.js";

interface Widget extends Entity {
  name: string;
}

describe("namespaces", () => {
  describe("Store", () => {
    it("forks a new namespace from the default namespace", () => {
      const store = new Store();
      const widgets = store.collection<Widget>("widgets", ["name"]);
      widgets.insert({ name: "seeded" });
      store.setData("clock", 42);

      runInNamespace("a", () => {
        expect(widgets.all().map((w) => w.name)).toEqual(["seeded"]);
        expect(widgets.findOneBy("name", "seeded")?.id).toBe(1);
        expect(store.getData("clock")).toBe(42);
      });
    });

    it("keeps writes private to their namespace", () => {
      const store = new Store();
      const widgets = store.collection<Widget>("widgets", ["name"]);
      widgets.insert({ name: "seeded" });

      runInNamespace("a", () => {
        widgets.insert({ name: "only-a" });
        store.setData("owner", "a");
      });
      runInNamespace("b", () => {
        expect(widgets.findBy("name", "only-a")).toEqual([]);
        expect(widgets.count()).toBe(1);
        expect(store.getData("owner")).toBeUndefined();
      });
      expect(widgets.count()).toBe(1);
      expect(store.namespaces()).toEqual(["a", "b"]);
    });

    it("does not share seeded objects between namespaces", () => {
      const store = new Store();
      const widgets = store.collection<Widget>("widgets");
      const seeded = widgets.insert({ name: "seeded" });

      runInNamespace("a", () => widgets.update(seeded.id, { name: "renamed" }));

      expect(widgets.get(seeded.id)?.name).toBe("seeded");
    });

    it("forks from the default namespace as it stands when the namespace is first used", () => {
      const store = new Store();
      const widgets = store.collection<Widget>("widgets");
      widgets.insert({ name: "first" });
      runInNamespace("early", () => widgets.count());
      widgets.insert({ name: "second" });

      runInNamespace("early", () => expect(widgets.count()).toBe(1));
      runInNamespace("late", () => expect(widgets.count()).toBe(2));
    });

    it("resets and drops one namespace at a time", () => {
      const store = new Store();
      const widgets = store.collection<Widget>("widgets");
      widgets.insert({ name: "seeded" });

      runInNamespace("a", () => {
        widgets.insert({ name: "extra" });
        store.reset();
        expect(widgets.count()).toBe(0);
      });
      expect(widgets.count()).toBe(1);

      expect(store.dropNamespace("a")).toBe(true);
      expect(store.dropNamespace("a")).toBe(false);
      runInNamespace("a", () => expect(widgets.count()).toBe(1));
    });

    it("snapshots and restores the current namespace", () => {
      const store = new Store();
      const widgets = store.collection<Widget>("widgets");
      widgets.insert({ name: "seeded" });

      const snapshot = runInNamespace("a", () => {
        widgets.insert({ name: "extra" });
        return store.snapshot();
      });

      expect(snapshot.collections.widgets.items).toHaveLength(2);
      runInNamespace("b", () => {
        store.restore(snapshot);
        expect(widgets.count()).toBe(2);
      });
      expect(widgets.count()).toBe(1);
    });
  });

  describe("server", () => {
    const plugin: ServicePlugin = {
      name: "widgets",
      register(app, store) {
        const widgets = store.collection<Widget>("widgets");
        app.get("/widgets", (c) => c.json({ namespace: currentNamespace(), names: widgets.all().map((w) => w.name) }));
        app.post("/widgets", async (c) => {
          const body = (await c.req.json()) as { name: string };
          return c.json(widgets.insert({ name: body.name }));
        });
      },
      seed(store) {
        store.collection<Widget>("widgets").insert({ name: "seeded" });
      },
    };

    async function listNames(app: ReturnType<typeof createServer>["app"], namespace?: string) {
      const response = await app.request("/widgets", {
        headers: namespace ? { [NAMESPACE_HEADER]: namespace } : {},
      });
      return (await response.json()) as { namespace: string; names: string[] };
    }

    it("selects the namespace from the request header", async () => {
      const { app, store } = createServer(plugin);
      plugin.seed!(store, "http://localhost");

      await app.request("/widgets", {
        method: "POST",
        headers: { [NAMESPACE_HEADER]: "test-1", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "from-test-1" }),
      });

      expect(await listNames(app, "test-1")).toEqual({ namespace: "test-1", names: ["seeded", "from-test-1"] });
      expect(await listNames(app, "test-2")).toEqual({ namespace: "test-2", names: ["seeded"] });
      expect(await listNames(app)).toEqual({ namespace: "", names: ["seeded"] });
    });

    it("lists and drops namespaces over HTTP", async () => {
      const { app, store } = createServer(plugin);
      plugin.seed!(store, "http://localhost");
      await listNames(app, "test-1");

      const listed = await app.request("/_emulate/namespaces");
      expect(await listed.json()).toEqual({ namespaces: ["test-1"] });

      const dropped = await app.request("/_emulate/namespaces/test-1", { method: "DELETE" });
      expect(await dropped.json()).toEqual({ namespace: "test-1", dropped: true });
      expect(await (await app.request("/_emulate/namespaces")).json()).toEqual({ namespaces: [] });
    });
  });

  describe("webhooks", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("forwards the namespace on deliveries", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const dispatcher = new WebhookDispatcher();
      dispatcher.register({ url: "https://app.example/hook", events: ["*"], active: true, owner: "o" });

      await runInNamespace("test-1", () => dispatcher.dispatch("ping", undefined, {}, "o"));
      await dispatcher.dispatch("ping", undefined, {}, "o");

      const [, first] = fetchMock.mock.calls[0] as [string, RequestInit];
      const [, second] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect((first.headers as Record<string, string>)[NAMESPACE_HEADER]).toBe("test-1");
      expect((second.headers as Record<string, string>)[NAMESPACE_HEADER]).toBeUndefined();
    });
  });
});

describe("namespaced rate limits", () => {
  it("counts requests per namespace", async () => {
    const plugin: ServicePlugin = {
      name: "ping",
      register(app) {
        app.get("/ping", (c) => c.json({ ok: true }));
      },
    };
    const { app } = createServer(plugin);
    const remaining = async (namespace?: string) => {
      const response = await app.request("/ping", {
        headers: { Authorization: "Bearer t", ...(namespace ? { [NAMESPACE_HEADER]: namespace } : {}) },
      });
      return Number(response.headers.get("X-RateLimit-Remaining"));
    };

    await remaining("a");
    await remaining("a");
    expect(await remaining("a")).toBe(4997);
    expect(await remaining("b")).toBe(4999);
    expect(await remaining()).toBe(4999);
  });
});
