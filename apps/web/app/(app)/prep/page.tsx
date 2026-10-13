import type { Metadata } from "next";
import { PrepClient } from "./prep-client";

export const metadata: Metadata = { title: "Interview Prep — Offerly" };

export default function PrepPage() {
  return <PrepClient />;
}
