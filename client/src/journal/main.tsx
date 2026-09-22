import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { JournalApp } from "./JournalApp";
import "../index.css";

/**
 * Точка входа журнала разбора сделок — отдельная PWA «Bablo.Дневник» (journal.html,
 * scope /journal). Свой бандл и палитра iOS (класс theme-journal на <html>); из общего
 * с терминалом — вход по PIN, транспорт API и цветовые токены-классы.
 */
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter basename="/journal">
      <JournalApp />
    </BrowserRouter>
  </StrictMode>,
);
