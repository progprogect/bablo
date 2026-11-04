import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BingXApiError } from "../bingx/client.js";
import { bingxMessage, logBingxFailure } from "./orders.js";

describe("bingxMessage", () => {
  it("ответ биржи дополняет шагом и кодом — раньше шаг терялся", () => {
    const message = bingxMessage(
      new BingXApiError(80001, "Insufficient margin"),
      "Не удалось открыть позицию на BingX",
    );
    assert.equal(
      message,
      "Не удалось открыть позицию на BingX: Insufficient margin (код BingX 80001)",
    );
  });

  it("не-JSON ответ (code -1): код не показываем, текст уже содержит HTTP-статус", () => {
    const message = bingxMessage(
      new BingXApiError(-1, "HTTP 403, ответ не JSON: <html>forbidden</html>"),
      "Не удалось открыть позицию на BingX",
    );
    assert.equal(
      message,
      "Не удалось открыть позицию на BingX: HTTP 403, ответ не JSON: <html>forbidden</html>",
    );
  });

  it("сетевая ошибка без кода BingX — тоже с шагом", () => {
    const message = bingxMessage(new Error("fetch failed"), "Не удалось получить цену с BingX");
    assert.equal(message, "Не удалось получить цену с BingX: fetch failed");
  });

  it("не-Error (или пустое сообщение) — только текст шага", () => {
    assert.equal(bingxMessage("что-то", "Не удалось закрыть позицию на BingX"), "Не удалось закрыть позицию на BingX");
    assert.equal(bingxMessage(new Error(""), "Не удалось закрыть позицию на BingX"), "Не удалось закрыть позицию на BingX");
  });
});

describe("logBingxFailure", () => {
  const originalError = console.error;
  afterEach(() => {
    console.error = originalError;
  });

  it("пишет шаг, код и текст — по 502 в логах должно быть видно причину", () => {
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));

    logBingxFailure("рыночный вход в позицию", new BingXApiError(80001, "Insufficient margin"));
    logBingxFailure("цена перед входом", new Error("fetch failed"));

    assert.equal(lines[0], "[trades] рыночный вход в позицию — отказ BingX: code 80001: Insufficient margin");
    assert.equal(lines[1], "[trades] цена перед входом — отказ BingX: Error: fetch failed");
  });
});
