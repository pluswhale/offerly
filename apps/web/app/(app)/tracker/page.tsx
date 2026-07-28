import type { Metadata } from "next";
import { TrackerClient } from "./tracker-client";

export const metadata: Metadata = { title: "Tracker — Offerly" };

export default function TrackerPage() {
  return <TrackerClient />;
}
