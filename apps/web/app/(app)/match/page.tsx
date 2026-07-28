import type { Metadata } from "next";
import { MatchClient } from "./match-client";

export const metadata: Metadata = { title: "Job Match — Offerly" };

export default function MatchPage() {
  return <MatchClient />;
}
