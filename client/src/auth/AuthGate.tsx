import { useEffect, useState, type ReactNode } from "react";
import { getAuthStatus } from "../api/client";
import { PinSetup } from "../screens/auth/PinSetup";
import { PinLogin } from "../screens/auth/PinLogin";

type Phase = "loading" | "setup" | "login" | "error" | "ready";

/** Гейт доступа: пока PIN не подтверждён, остальное приложение не рендерится. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    refreshStatus();
  }, []);

  async function refreshStatus() {
    try {
      const status = await getAuthStatus();
      if (status.authenticated) {
        setPhase("ready");
      } else {
        setPhase(status.hasPin ? "login" : "setup");
      }
    } catch {
      setPhase("error");
    }
  }

  if (phase === "loading") {
    return <CenteredMessage>Загрузка…</CenteredMessage>;
  }
  if (phase === "error") {
    return <CenteredMessage>Не удалось связаться с сервером</CenteredMessage>;
  }
  if (phase === "setup") {
    return <PinSetup onDone={() => setPhase("ready")} />;
  }
  if (phase === "login") {
    return <PinLogin onDone={() => setPhase("ready")} />;
  }

  return <>{children}</>;
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-1 items-center justify-center bg-surface px-6 text-sm text-slate-500">
      {children}
    </section>
  );
}
