import { DEFAULT_NAMESPACE, currentNamespace } from "./namespace.js";

export interface Entity {
  id: number;
  created_at: string;
  updated_at: string;
}

export type InsertInput<T extends Entity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export type FilterFn<T> = (item: T) => boolean;
export type SortFn<T> = (a: T, b: T) => number;

export interface QueryOptions<T> {
  filter?: FilterFn<T>;
  sort?: SortFn<T>;
  page?: number;
  per_page?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CollectionSnapshot<T extends Entity = Entity> {
  items: T[];
  autoId: number;
  indexFields: string[];
}

export interface StoreSnapshot {
  collections: Record<string, CollectionSnapshot>;
  data: Record<string, unknown>;
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof Map) {
    return { __type: "Map" as const, entries: [...value.entries()].map(([k, v]) => [k, serializeValue(v)]) };
  }
  if (value instanceof Set) {
    return { __type: "Set" as const, values: [...value.values()] };
  }
  return value;
}

export function deserializeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "__type" in value) {
    const tagged = value as Record<string, unknown>;
    if (tagged.__type === "Map") {
      const entries = tagged.entries as [unknown, unknown][];
      return new Map(entries.map(([k, v]) => [k, deserializeValue(v)]));
    }
    if (tagged.__type === "Set") {
      return new Set(tagged.values as unknown[]);
    }
  }
  return value;
}

function cloneValue<V>(value: V): V {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

interface CollectionState<T> {
  items: Map<number, T>;
  indexes: Map<string, Map<string, Set<number>>>;
  autoId: number;
}

/**
 * Rows live in one bucket per namespace (see `namespace.ts`). The schema
 * (collection names and index fields) is shared; the rows are not.
 */
export class Collection<T extends Entity> {
  private states = new Map<string, CollectionState<T>>();
  readonly fieldNames: string[];

  constructor(private indexFields: (keyof T)[] = []) {
    this.fieldNames = indexFields.map(String).sort();
  }

  private emptyState(): CollectionState<T> {
    const indexes = new Map<string, Map<string, Set<number>>>();
    for (const field of this.indexFields) {
      indexes.set(String(field), new Map());
    }
    return { items: new Map(), indexes, autoId: 1 };
  }

  private forkedState(source: CollectionState<T>): CollectionState<T> {
    const state = this.emptyState();
    state.autoId = source.autoId;
    for (const [id, item] of source.items) {
      const copy = cloneValue(item);
      state.items.set(id, copy);
      this.addToIndex(state, copy);
    }
    return state;
  }

  private state(): CollectionState<T> {
    const namespace = currentNamespace();
    const existing = this.states.get(namespace);
    if (existing) return existing;
    const base = this.states.get(DEFAULT_NAMESPACE);
    const created = namespace !== DEFAULT_NAMESPACE && base ? this.forkedState(base) : this.emptyState();
    this.states.set(namespace, created);
    return created;
  }

  private addToIndex(state: CollectionState<T>, item: T): void {
    for (const field of this.indexFields) {
      const value = item[field];
      if (value === undefined || value === null) continue;
      const indexMap = state.indexes.get(String(field))!;
      const key = String(value);
      if (!indexMap.has(key)) {
        indexMap.set(key, new Set());
      }
      indexMap.get(key)!.add(item.id);
    }
  }

  private removeFromIndex(state: CollectionState<T>, item: T): void {
    for (const field of this.indexFields) {
      const value = item[field];
      if (value === undefined || value === null) continue;
      const indexMap = state.indexes.get(String(field))!;
      const key = String(value);
      indexMap.get(key)?.delete(item.id);
    }
  }

  insert(data: InsertInput<T>): T {
    const state = this.state();
    const now = new Date().toISOString();
    const explicitId = data.id != null && data.id > 0 ? data.id : undefined;
    const id = explicitId ?? state.autoId++;
    if (id >= state.autoId) {
      state.autoId = id + 1;
    }
    const item = {
      ...data,
      id,
      created_at: now,
      updated_at: now,
    } as unknown as T;
    state.items.set(id, item);
    this.addToIndex(state, item);
    return item;
  }

  get(id: number): T | undefined {
    return this.state().items.get(id);
  }

  findBy(field: keyof T, value: T[keyof T] | string | number): T[] {
    const state = this.state();
    if (state.indexes.has(String(field))) {
      const ids = state.indexes.get(String(field))!.get(String(value));
      if (!ids) return [];
      return Array.from(ids)
        .map((id) => state.items.get(id)!)
        .filter(Boolean);
    }
    return this.all().filter((item) => item[field] === value);
  }

  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined {
    return this.findBy(field, value)[0];
  }

  update(id: number, data: Partial<T>): T | undefined {
    const state = this.state();
    const existing = state.items.get(id);
    if (!existing) return undefined;
    this.removeFromIndex(state, existing);
    const updated = {
      ...existing,
      ...data,
      id,
      updated_at: new Date().toISOString(),
    } as T;
    state.items.set(id, updated);
    this.addToIndex(state, updated);
    return updated;
  }

  delete(id: number): boolean {
    const state = this.state();
    const existing = state.items.get(id);
    if (!existing) return false;
    this.removeFromIndex(state, existing);
    return state.items.delete(id);
  }

  all(): T[] {
    return Array.from(this.state().items.values());
  }

  query(options: QueryOptions<T> = {}): PaginatedResult<T> {
    let results = this.all();

    if (options.filter) {
      results = results.filter(options.filter);
    }

    const total_count = results.length;

    if (options.sort) {
      results.sort(options.sort);
    }

    const page = options.page ?? 1;
    const per_page = Math.min(options.per_page ?? 30, 100);
    const start = (page - 1) * per_page;
    const paged = results.slice(start, start + per_page);

    return {
      items: paged,
      total_count,
      page,
      per_page,
      has_next: start + per_page < total_count,
      has_prev: page > 1,
    };
  }

  count(filter?: FilterFn<T>): number {
    if (!filter) return this.state().items.size;
    return this.all().filter(filter).length;
  }

  clear(): void {
    this.states.set(currentNamespace(), this.emptyState());
  }

  dropNamespace(namespace: string): boolean {
    return this.states.delete(namespace);
  }

  namespaces(): string[] {
    return [...this.states.keys()];
  }

  snapshot(): CollectionSnapshot<T> {
    return {
      items: this.all(),
      autoId: this.state().autoId,
      indexFields: this.fieldNames,
    };
  }

  restore(snap: CollectionSnapshot<T>): void {
    this.clear();
    const state = this.state();
    state.autoId = snap.autoId;
    for (const item of snap.items) {
      state.items.set(item.id, item);
      this.addToIndex(state, item);
    }
  }
}

export class Store {
  private collections = new Map<string, Collection<any>>();
  private dataByNamespace = new Map<string, Map<string, unknown>>();

  private data(): Map<string, unknown> {
    const namespace = currentNamespace();
    const existing = this.dataByNamespace.get(namespace);
    if (existing) return existing;
    const base = this.dataByNamespace.get(DEFAULT_NAMESPACE);
    const created =
      namespace !== DEFAULT_NAMESPACE && base
        ? new Map([...base].map(([key, value]) => [key, cloneValue(value)] as const))
        : new Map<string, unknown>();
    this.dataByNamespace.set(namespace, created);
    return created;
  }

  collection<T extends Entity>(name: string, indexFields: (keyof T)[] = []): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) {
      if (indexFields.length > 0) {
        const requested = indexFields.map(String).sort();
        if (existing.fieldNames.length !== requested.length || existing.fieldNames.some((f, i) => f !== requested[i])) {
          throw new Error(
            `Collection "${name}" already exists with indexes [${existing.fieldNames}] but was requested with [${requested}]`,
          );
        }
      }
      return existing as Collection<T>;
    }
    const col = new Collection<T>(indexFields);
    this.collections.set(name, col);
    return col;
  }

  getData<V>(key: string): V | undefined {
    return this.data().get(key) as V | undefined;
  }

  setData<V>(key: string, value: V): void {
    this.data().set(key, value);
  }

  /** Wipes the current namespace only. */
  reset(): void {
    for (const collection of this.collections.values()) {
      collection.clear();
    }
    this.data().clear();
  }

  /** Forgets a namespace; its next request forks the default namespace again. */
  dropNamespace(namespace: string): boolean {
    let dropped = this.dataByNamespace.delete(namespace);
    for (const collection of this.collections.values()) {
      dropped = collection.dropNamespace(namespace) || dropped;
    }
    return dropped;
  }

  namespaces(): string[] {
    const names = new Set<string>(this.dataByNamespace.keys());
    for (const collection of this.collections.values()) {
      for (const namespace of collection.namespaces()) names.add(namespace);
    }
    return [...names].filter((namespace) => namespace !== DEFAULT_NAMESPACE).sort();
  }

  snapshot(): StoreSnapshot {
    const collections: Record<string, CollectionSnapshot> = {};
    for (const [name, col] of this.collections) {
      collections[name] = col.snapshot();
    }
    const data: Record<string, unknown> = {};
    for (const [key, value] of this.data()) {
      data[key] = serializeValue(value);
    }
    return { collections, data };
  }

  restore(snap: StoreSnapshot): void {
    const snapshotNames = new Set(Object.keys(snap.collections));
    for (const name of this.collections.keys()) {
      if (!snapshotNames.has(name)) {
        this.collections.delete(name);
      }
    }
    for (const [name, colSnap] of Object.entries(snap.collections)) {
      const indexFields = colSnap.indexFields as (keyof Entity)[];
      const col = this.collection(name, indexFields);
      col.restore(colSnap as CollectionSnapshot<any>);
    }
    const data = this.data();
    data.clear();
    for (const [key, value] of Object.entries(snap.data)) {
      data.set(key, deserializeValue(value));
    }
  }
}
