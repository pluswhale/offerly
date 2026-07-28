import type { Metadata } from "next";
import { CoachClient } from "./coach-client";

export const metadata: Metadata = { title: "AI Coach — Offerly" };

export default function CoachPage() {
  return <CoachClient />;
}
