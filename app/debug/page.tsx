import type { Metadata } from "next";
import { DebugDashboard } from "./DebugDashboard";

export const metadata: Metadata = {
  title: "Debug | Palimpsest",
  description: "Live Palimpsest operations, failures, uploads, and viewer activity.",
  robots: { index: false, follow: false },
};

export default function DebugPage() {
  return <DebugDashboard />;
}
