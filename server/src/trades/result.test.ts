import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeResult, resolveRecalculateClosePrice } from "./result.js";

describe("resolveRecalculateClosePrice", () => {
  const base = {
    side: "long" as const,
    entryPrice: 100,
    quantity: 10,
    riskUsd: 50, // 1R = $5 move
    slPrice: 95,
    closePrice: 100 as number | null,
    closeReason: "sl" as string | null,
    partialTpFilledAt: null as Date | null,
    bingxFillPrice: null as number | null,
  };

  it("предпочитает fill BingX", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      bingxFillPrice: 94.5,
      closePrice: 100,
    });
    assert.deepEqual(resolved, { closePrice: 94.5, source: "bingx" });
  });

  it("при SL и close≈entry берёт slPrice (баг rp=0 / ap=entry)", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      closePrice: 100,
      slPrice: 95,
    });
    assert.deepEqual(resolved, { closePrice: 95, source: "sl" });
  });

  it("оставляет stored close, если он уже даёт заметный R", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      closePrice: 90, // −2R
      slPrice: 95,
    });
    assert.deepEqual(resolved, { closePrice: 90, source: "stored" });
  });

  it("не подменяет на SL, если стоп уже на стороне прибыли (БУ после partial)", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      closePrice: 100,
      slPrice: 100, // на входе
    });
    assert.deepEqual(resolved, { closePrice: 100, source: "stored" });
  });

  it("не подменяет на SL при исполненной partial", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      closePrice: 100,
      slPrice: 95,
      partialTpFilledAt: new Date("2026-08-04T12:00:00Z"),
    });
    assert.deepEqual(resolved, { closePrice: 100, source: "stored" });
  });

  it("без closePrice при SL берёт slPrice", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      closePrice: null,
      slPrice: 95,
    });
    assert.deepEqual(resolved, { closePrice: 95, source: "sl" });
  });

  it("без источников возвращает null", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      closePrice: null,
      slPrice: null,
      closeReason: "manual",
    });
    assert.equal(resolved, null);
  });
});

describe("computeResult + resolve: сценарий VIRTUAL rp=0", () => {
  it("пересчёт через slPrice даёт −1R вместо 0", () => {
    const trade = {
      entryPrice: "1.20",
      quantity: "1000",
      riskUsd: "60", // 1R = $0.06 move
      side: "long",
    };
    // close записан как entry → 0R
    assert.equal(computeResult(trade, 1.2, null).resultR, 0);

    const resolved = resolveRecalculateClosePrice({
      side: "long",
      entryPrice: 1.2,
      quantity: 1000,
      riskUsd: 60,
      slPrice: 1.14,
      closePrice: 1.2,
      closeReason: "sl",
      partialTpFilledAt: null,
    });
    assert.ok(resolved);
    assert.equal(resolved.source, "sl");
    const { resultR } = computeResult(trade, resolved.closePrice, null);
    assert.ok(Math.abs(resultR - -1) < 1e-9);
  });
});
