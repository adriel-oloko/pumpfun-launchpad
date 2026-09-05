"use client";

// Global notification popups, ported from v4-launchpad: shown for launched /
// failed txs, each auto-dismissing after TOAST_MS with a timer bar at the
// top that shrinks over the visible period. Stacked top-right, newest on
// top, oldest evicted beyond MAX_TOASTS. Error tone = inverted ink card.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ExplorerLink } from "./ui";

/** How long each notification stays visible (matches the timer bar). */
export const TOAST_MS = 3000;

/** How many notifications stack at once; the oldest is evicted beyond this. */
const MAX_TOASTS = 5;

export type ToastInput = {
  /** Action label: 'LAUNCHED' | 'BOUGHT' | 'SOLD' | '... FAILED' */
  action: string;
  /** Amount line, e.g. '$SMPL' or 'TX REVERTED'. */
  amount?: string;
  /** Tx hash / signature shown under the action (Solana base58). */
  txHash?: string;
  /** Error variant: inverted ink card (the design system's error signal). */
  tone?: "ok" | "error";
};

/** Short failure label for a toast amount line ('USER REJECTED', 'TX REVERTED'...). */
export function shortFailureReason(message: string): string {
  if (/user rejected|user denied|declined|action rejected/i.test(message))
    return "USER REJECTED";
  if (/insufficient balance|underfunded|0 tokens/i.test(message))
    return "INSUFFICIENT FUNDS";
  if (/executionfailed|revert/i.test(message)) return "TX REVERTED";
  if (
    /failed to fetch|http request failed|network|timed? ?out|rate limit/i.test(
      message
    )
  )
    return "RPC UNREACHABLE";
  if (/not mined|relay|flashbots|502|403/i.test(message)) return "RELAY DROP";
  const trimmed = message.trim();
  return trimmed.length > 32 ? `${trimmed.slice(0, 29)}...` : trimmed;
}

type Toast = ToastInput & { id: number };

const ToastContext = createContext<{
  pushToast: (t: ToastInput) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((input: ToastInput) => {
    const id = ++nextId.current;
    setToasts((prev) => [
      ...prev.slice(-(MAX_TOASTS - 1)),
      { ...input, id },
    ]);
  }, []);

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* pointer-events-none so the empty stack never blocks the page */}
      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {[...toasts].reverse().map((t) => (
          <ToastItem key={t.id} toast={t} onDone={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDone,
}: {
  toast: Toast;
  onDone: (id: number) => void;
}) {
  const { action, amount, txHash, id, tone } = toast;
  const isError = tone === "error";

  // Auto-dismiss after TOAST_MS; the CSS timer bar runs the same window.
  useEffect(() => {
    const t = setTimeout(() => onDone(id), TOAST_MS);
    return () => clearTimeout(t);
  }, [id, onDone]);

  return (
    <div
      className={`${isError ? "card-brutal-inverted" : "card-brutal"} pointer-events-auto relative`}
      role={isError ? "alert" : "status"}>
      {/* time slider: shrinks from full width to 0 over TOAST_MS */}
      <div
        className={`toast-timer h-1.5 ${isError ? "bg-paper" : "bg-ink"}`}
      />
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <p
            className={`label-mono !text-[12px] font-bold break-all ${isError ? "text-paper" : ""}`}>
            {action}
            {amount ? ` ${amount}` : ""}
          </p>
          {txHash ? (
            <p className="mt-1 font-mono text-[11px]">
              <ExplorerLink hash={txHash} inverted={isError} />
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => onDone(id)}
          className={`label-mono shrink-0 border-2 px-1.5 leading-[1.2] ${
            isError
              ? "border-paper text-paper hover:bg-paper hover:text-ink"
              : "border-ink hover:bg-ink hover:text-paper"
          }`}>
          ×
        </button>
      </div>
    </div>
  );
}

export function useToasts() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used inside <ToastProvider>");
  return ctx;
}
