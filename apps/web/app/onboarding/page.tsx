"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { Cv, Profile } from "@offerly/types";
import { api } from "@/lib/api";
import type { CreateCvUploadResponse } from "@/lib/contract";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Input } from "@/components/input";
import { Textarea } from "@/components/textarea";

type Step = 0 | 1 | 2;

/**
 * Onboarding (T3.1): 3 steps max — basics → CV upload/paste/skip → done.
 * Sets profiles.onboarding_completed at the end. Target: <2 minutes.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Step 1 — basics
  const [fullName, setFullName] = useState("");
  const [currentRole, setCurrentRole] = useState("");
  const [targetRole, setTargetRole] = useState("");

  // Step 2 — CV
  const [cvMode, setCvMode] = useState<"upload" | "paste">("upload");
  const [pastedText, setPastedText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function saveBasics() {
    setSaving(true);
    setError(null);
    try {
      await api<Profile>("/profiles/me", {
        method: "PATCH",
        json: {
          full_name: fullName.trim(),
          current_role: currentRole.trim() || undefined,
          target_role: targetRole.trim() || undefined,
        },
      });
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function saveCv() {
    setSaving(true);
    setError(null);
    try {
      if (cvMode === "paste") {
        await api<Cv>("/cvs", {
          method: "POST",
          json: { text: pastedText.trim() },
        });
      } else {
        const file = fileRef.current?.files?.[0];
        if (!file) throw new Error("Choose a PDF or DOCX file first");
        const created = await api<CreateCvUploadResponse>("/cvs", {
          method: "POST",
          json: {
            filename: file.name,
            content_type: file.type,
            size_bytes: file.size,
          },
        });
        // Direct-to-Storage upload via the signed URL (plan §9).
        const res = await fetch(created.signed_url, { method: "PUT", body: file });
        if (!res.ok) throw new Error("File upload failed — try pasting the text instead");
        // Trigger server-side text extraction (T5.1); 422 = scanned PDF.
        await api<Cv>("/cvs/confirm", {
          method: "POST",
          json: { cv_id: created.cv.id },
        });
      }
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your CV");
      setSaving(false);
    }
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      await api<Profile>("/profiles/me", {
        method: "PATCH",
        json: { onboarding_completed: true },
      });
      setStep(2);
      setSaving(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish setup");
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <p className="mb-2 text-center text-sm font-medium text-accent-600">
          Step {step + 1} of 3
        </p>
        <div className="mb-6 flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-accent-600" : "bg-neutral-200"}`}
            />
          ))}
        </div>

        <Card className="p-6">
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <div>
                <h1 className="text-xl font-semibold text-neutral-900">The basics</h1>
                <p className="mt-1 text-sm text-neutral-500">
                  This personalizes your analyses and AI output.
                </p>
              </div>
              <Input
                label="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Alex Smith"
                autoComplete="name"
                required
              />
              <Input
                label="Current role (optional)"
                value={currentRole}
                onChange={(e) => setCurrentRole(e.target.value)}
                placeholder="Frontend Developer"
              />
              <Input
                label="Target role (optional)"
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                placeholder="Senior Frontend Engineer"
              />
              <Button onClick={saveBasics} loading={saving} disabled={!fullName.trim()}>
                Continue
              </Button>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div>
                <h1 className="text-xl font-semibold text-neutral-900">Add your CV</h1>
                <p className="mt-1 text-sm text-neutral-500">
                  Unlocks your first analysis — you can also skip and do it later.
                </p>
              </div>
              <div className="flex gap-2" role="tablist" aria-label="CV input method">
                <Button
                  variant={cvMode === "upload" ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setCvMode("upload")}
                >
                  Upload file
                </Button>
                <Button
                  variant={cvMode === "paste" ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setCvMode("paste")}
                >
                  Paste text
                </Button>
              </div>
              {cvMode === "upload" ? (
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="cv-file"
                    className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center hover:border-accent-400"
                  >
                    <span className="text-sm font-medium text-neutral-700">
                      {fileName ?? "Choose a PDF or DOCX (max 5 MB)"}
                    </span>
                    <span className="text-xs text-neutral-500">Tap to browse</span>
                  </label>
                  <input
                    id="cv-file"
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="sr-only"
                    onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                  />
                </div>
              ) : (
                <Textarea
                  label="CV text"
                  rows={8}
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder="Paste the full text of your CV…"
                />
              )}
              <Button
                onClick={saveCv}
                loading={saving}
                disabled={cvMode === "upload" ? !fileName : pastedText.trim().length < 50}
              >
                Save and continue
              </Button>
              <button
                type="button"
                onClick={finish}
                disabled={saving}
                className="min-h-11 cursor-pointer text-sm font-medium text-neutral-500 hover:text-neutral-700"
              >
                Skip for now
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <p className="text-lg font-semibold text-neutral-900">You&apos;re all set</p>
              <Button onClick={() => router.push("/dashboard")}>Go to dashboard</Button>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </Card>
      </div>
    </main>
  );
}
