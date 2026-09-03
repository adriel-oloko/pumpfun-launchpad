"use client";

import { CreatorWalletProvider } from "../lib/creator-wallet";
import { ToastProvider } from "./toast-stack";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <CreatorWalletProvider>
      <ToastProvider>{children}</ToastProvider>
    </CreatorWalletProvider>
  );
}
