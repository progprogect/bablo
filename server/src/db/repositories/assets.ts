import { asc, eq } from "drizzle-orm";
import { getDb } from "../client.js";
import { assets } from "../schema.js";

export type Asset = typeof assets.$inferSelect;

const DEFAULT_ASSETS: Array<{ symbol: string; leverage: number; sortOrder: number }> = [
  { symbol: "TIA-USDT", leverage: 20, sortOrder: 0 },
  { symbol: "TAO-USDT", leverage: 25, sortOrder: 1 },
  { symbol: "VIRTUAL-USDT", leverage: 25, sortOrder: 2 },
  { symbol: "WLD-USDT", leverage: 20, sortOrder: 3 },
];

/** Идемпотентный сид: выполняется на старте сервера, если таблица активов пуста. */
export async function ensureSeedAssets(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: assets.id }).from(assets).limit(1);
  if (existing.length > 0) {
    return;
  }
  await db.insert(assets).values(DEFAULT_ASSETS);
}

export async function listAssets(): Promise<Asset[]> {
  const db = getDb();
  return db.select().from(assets).orderBy(asc(assets.sortOrder));
}

export async function listActiveAssets(): Promise<Asset[]> {
  const db = getDb();
  return db
    .select()
    .from(assets)
    .where(eq(assets.isActive, true))
    .orderBy(asc(assets.sortOrder));
}

export type CreateAssetInput = {
  symbol: string;
  leverage: number;
  sortOrder?: number;
  isActive?: boolean;
};

export async function createAsset(input: CreateAssetInput): Promise<Asset> {
  const db = getDb();
  const [created] = await db
    .insert(assets)
    .values({
      symbol: input.symbol,
      leverage: input.leverage,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    })
    .returning();
  if (!created) {
    throw new Error("Не удалось создать актив");
  }
  return created;
}

export type UpdateAssetInput = Partial<CreateAssetInput>;

export async function updateAsset(id: number, input: UpdateAssetInput): Promise<Asset | null> {
  const db = getDb();
  const [updated] = await db.update(assets).set(input).where(eq(assets.id, id)).returning();
  return updated ?? null;
}

export async function deleteAsset(id: number): Promise<void> {
  const db = getDb();
  await db.delete(assets).where(eq(assets.id, id));
}
