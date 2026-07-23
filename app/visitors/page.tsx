import type { Metadata } from "next";
import { VisitorDashboard } from "./VisitorDashboard";

export const metadata: Metadata = {
  title: "Visitor activity | Palimpsest",
  robots: { index: false, follow: false },
};

export default function VisitorsPage() {
  return <VisitorDashboard />;
}
