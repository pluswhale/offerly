import type { Metadata } from "next";
import { CvDetailClient } from "./cv-detail-client";

export const metadata: Metadata = { title: "CV Analysis — Offerly" };

export default async function CvDetailPage({
  params,
}: {
  params: Promise<{ cvId: string }>;
}) {
  const { cvId } = await params;
  return <CvDetailClient cvId={cvId} />;
}
