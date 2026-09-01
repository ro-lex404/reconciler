import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Razorpay Reconciler | AI Finance Controller",
  description: "Autonomous Multi-Source Financial Reconciliation Engine powered by DuckDB, LangGraph & Groq",
  icons: {
    icon: "https://razorpay.com/favicon.ico",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-900 font-sans">{children}</body>
    </html>
  );
}
