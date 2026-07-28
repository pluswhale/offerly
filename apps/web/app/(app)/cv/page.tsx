import type { Metadata } from "next";
import { CvListClient } from "./cv-list-client";

export const metadata: Metadata = { title: "CV — Offerly" };

export default function CvPage() {
  return <CvListClient />;
}
