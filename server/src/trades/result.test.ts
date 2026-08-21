import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeResult,
  computeResultFromExchangeFills,
  resolveRecalculateClosePrice,
  resultFromManualPnl,
  shouldTrustExchangeResult,
} from "./result.js";

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

  it("игнорирует fill BingX ≈ entry и берёт slPrice", () => {
    const resolved = resolveRecalculateClosePrice({
      ...base,
      bingxFillPrice: 100,
      closePrice: 100,
      slPrice: 95,
    });
    assert.deepEqual(resolved, { closePrice: 95, source: "sl" });
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

describe("computeResultFromExchangeFills", () => {
  // Кейс 20.08.2026: partial 70% передвинута прямо на бирже (приложение о ней не знает),
  // остаток 30% выбило по исходному SL. Вход 100, qty 1, риск 10 USDT (SL 90).
  const trade = { entryPrice: 100, quantity: 1, riskUsd: 10, side: "long" };

  it("partial с биржи + финальный SL по rp из WS (истории ещё нет)", () => {
    // partial: 0.7 монеты по 120 → profit +14; финал: 0.3 по 90 → rp −3
    const result = computeResultFromExchangeFills(
      trade,
      [{ profit: 14, executedQty: 0.7 }],
      { closePrice: 90, realizedProfit: -3 },
    );
    assert.ok(result);
    assert.ok(Math.abs(result.resultR - 1.1) < 1e-9, `expected 1.1, got ${result.resultR}`);
  });

  it("история уже полная — rp финала не прибавляется второй раз", () => {
    const result = computeResultFromExchangeFills(
      trade,
      [
        { profit: 14, executedQty: 0.7 },
        { profit: -3, executedQty: 0.3 },
      ],
      { closePrice: 90, realizedProfit: -3 },
    );
    assert.ok(result);
    assert.ok(Math.abs(result.resultR - 1.1) < 1e-9, `expected 1.1, got ${result.resultR}`);
  });

  it("rp=0 на остатке при реальном ходе цены — остаток считается по цене закрытия", () => {
    const result = computeResultFromExchangeFills(
      trade,
      [{ profit: 14, executedQty: 0.7 }],
      { closePrice: 90, realizedProfit: 0 },
    );
    assert.ok(result);
    // остаток 0.3 × (90 − 100) = −3 → всего +11 → 1.1R
    assert.ok(Math.abs(result.resultR - 1.1) < 1e-9, `expected 1.1, got ${result.resultR}`);
  });

  it("закрытий в истории нет вовсе — весь объём по финальному ордеру", () => {
    const result = computeResultFromExchangeFills(trade, [], { closePrice: 90, realizedProfit: -10 });
    assert.ok(result);
    assert.equal(result.resultR, -1);
  });

  it("шорт: profit с биржи суммируется так же", () => {
    const shortTrade = { entryPrice: 100, quantity: 1, riskUsd: 10, side: "short" };
    const result = computeResultFromExchangeFills(
      shortTrade,
      [{ profit: 14, executedQty: 0.7 }],
      { closePrice: 110, realizedProfit: -3 },
    );
    assert.ok(result);
    assert.ok(Math.abs(result.resultR - 1.1) < 1e-9);
  });

  it("нет входа/объёма — null, вызывающая сторона остаётся на фолбэке", () => {
    assert.equal(
      computeResultFromExchangeFills(
        { entryPrice: null, quantity: 0, riskUsd: 10, side: "long" },
        [{ profit: 14, executedQty: 0.7 }],
        { closePrice: 90, realizedProfit: null },
      ),
      null,
    );
  });
});

describe("shouldTrustExchangeResult", () => {
  it("биржа главнее, когда её итог материален", () => {
    assert.equal(shouldTrustExchangeResult(1.1, -1), true);
    assert.equal(shouldTrustExchangeResult(-1.36, -1), true);
  });
  it("ноль с биржи при материальном расчётном R — почерк бага rp=0, не доверяем", () => {
    assert.equal(shouldTrustExchangeResult(0, -1.36), false);
    assert.equal(shouldTrustExchangeResult(0.01, 1.5), false);
  });
  it("оба около нуля — реальный безубыток, биржа принимается", () => {
    assert.equal(shouldTrustExchangeResult(0.02, 0.03), true);
  });
});

describe("resultFromManualPnl", () => {
  it("считает R и % из суммы", () => {
    const result = resultFromManualPnl({ entryPrice: 100, quantity: 1, riskUsd: 30 }, 44);
    assert.ok(result);
    assert.ok(Math.abs(result.resultR - 44 / 30) < 1e-9);
    assert.ok(Math.abs(result.resultPct - 44) < 1e-9);
  });
  it("отрицательная сумма — отрицательный R", () => {
    const result = resultFromManualPnl({ entryPrice: 100, quantity: 1, riskUsd: 30 }, -22.37);
    assert.ok(result);
    assert.ok(result.resultR < 0);
  });
  it("без riskUsd — null (R не определить)", () => {
    assert.equal(resultFromManualPnl({ entryPrice: 100, quantity: 1, riskUsd: 0 }, 44), null);
    assert.equal(resultFromManualPnl({ entryPrice: 100, quantity: 1, riskUsd: null }, 44), null);
  });
});
