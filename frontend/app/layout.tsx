import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus AI Reconciler | Autonomous Financial Controller & 3-Way Reconciliation Engine",
  description: "Autonomous Multi-Source Financial Reconciliation Engine and AI Finance Controller for Razorpay, Invoices, and Banking Ledgers.",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%233b82f6'><path d='M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z'/></svg>",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-950 font-sans text-slate-100">{children}</body>
    </html>
  );
}
