import Link from "next/link";
import { Card, CardBody } from "@/components/card";

const FEATURES = [
  {
    title: "CV Analyzer",
    description:
      "An honest score with section-by-section feedback and a prioritized fix list — so you stop guessing why you get silence.",
  },
  {
    title: "Job Match",
    description:
      "Paste a job description, get a 0–100 fit score with strengths, gaps, and what to fix before you apply.",
  },
  {
    title: "Tracker + AI Apply",
    description:
      "Every application in one pipeline, plus tailored cover letters grounded in your actual CV — never fabricated.",
  },
] as const;

export default function HomePage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-6 px-4 py-20 text-center md:py-28">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-neutral-900 md:text-5xl">
          Land your next offer faster
        </h1>
        <p className="max-w-xl text-lg text-neutral-600">
          Offerly is your AI career copilot: sharp CV feedback, honest job-match
          scores, and tailored applications — in minutes, not evenings.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/signup"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent-600 px-6 text-sm font-medium text-white shadow-sm hover:bg-accent-700"
          >
            Start free — no card required
          </Link>
          <Link
            href="/pricing"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-neutral-300 bg-white px-6 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            See pricing
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto w-full max-w-5xl px-4 pb-20">
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <CardBody className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-neutral-900">{f.title}</h2>
                <p className="text-sm text-neutral-600">{f.description}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="border-t border-neutral-100 bg-neutral-50">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-4 px-4 py-16 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">
            Free to start. Pro when you&apos;re serious.
          </h2>
          <p className="max-w-lg text-sm text-neutral-600">
            5 AI requests a month, one CV analysis, and a 10-job tracker — free forever.
            Upgrade for unlimited AI, the full Apply Assistant, and the AI Coach.
          </p>
          <Link
            href="/pricing"
            className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium text-accent-600 hover:text-accent-700"
          >
            Compare plans →
          </Link>
        </div>
      </section>
    </main>
  );
}
