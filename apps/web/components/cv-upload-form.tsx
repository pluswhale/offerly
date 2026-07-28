"use client";

import { useRef, useState } from "react";
import type { Cv } from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import type { CreateCvUploadResponse } from "@/lib/contract";
import { cvDisplayName } from "@/lib/format";
import { Button } from "./button";
import { Modal } from "./modal";
import { Textarea } from "./textarea";
import { UpgradeButton } from "./upgrade-button";

/**
 * CV upload form (T5.1/T5.3): PDF/DOCX via the signed-URL flow, or pasted
 * text (also the fallback for unreadable/scanned PDFs, spec §5.2).
 * Free-tier 1-CV limit (T12.3): a cv_create 402 opens a replace-or-upgrade
 * dialog; "replace" retries the same submission with replace_cv_id set.
 */
export function CvUploadForm({
  onUploaded,
  replaceCv,
}: {
  onUploaded: (cv: Cv) => void;
  /** CV offered for replacement when the free 1-CV limit is hit. */
  replaceCv?: Cv;
}) {
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [pastedText, setPastedText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(replaceCvId?: string) {
    setSaving(true);
    setError(null);
    try {
      let cv: Cv;
      if (mode === "paste") {
        cv = await api<Cv>("/cvs", {
          method: "POST",
          json: { text: pastedText.trim(), ...(replaceCvId ? { replace_cv_id: replaceCvId } : {}) },
        });
      } else {
        const file = fileRef.current?.files?.[0];
        if (!file) throw new Error("Choose a PDF or DOCX file first");
        if (file.size > 5 * 1024 * 1024)
          throw new Error("Files over 5 MB are not supported — paste the text instead");
        const created = await api<CreateCvUploadResponse>("/cvs", {
          method: "POST",
          json: {
            filename: file.name,
            content_type: file.type,
            size_bytes: file.size,
            ...(replaceCvId ? { replace_cv_id: replaceCvId } : {}),
          },
        });
        const res = await fetch(created.signed_url, { method: "PUT", body: file });
        if (!res.ok)
          throw new Error(
            "Upload failed. If this is a scanned PDF, paste the text instead.",
          );
        // Trigger server-side text extraction (T5.1); 422 = scanned PDF.
        cv = await api<Cv>("/cvs/confirm", {
          method: "POST",
          json: { cv_id: created.cv.id },
        });
      }
      setPastedText("");
      setFileName(null);
      onUploaded(cv);
    } catch (err) {
      if (err instanceof PaywallError && err.payload.feature === "cv_create") setLimitHit(true);
      else setError(err instanceof Error ? err.message : "Could not save your CV");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2" role="tablist" aria-label="CV input method">
        <Button
          variant={mode === "upload" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setMode("upload")}
        >
          Upload file
        </Button>
        <Button
          variant={mode === "paste" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setMode("paste")}
        >
          Paste text
        </Button>
      </div>

      {mode === "upload" ? (
        <div>
          <label
            htmlFor="cv-upload-file"
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center hover:border-accent-400"
          >
            <span className="text-sm font-medium text-neutral-700">
              {fileName ?? "Choose a PDF or DOCX (max 5 MB)"}
            </span>
            <span className="text-xs text-neutral-500">
              Scanned PDF without selectable text? Use paste instead.
            </span>
          </label>
          <input
            id="cv-upload-file"
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

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <Button
        onClick={() => void submit()}
        loading={saving}
        disabled={mode === "upload" ? !fileName : pastedText.trim().length < 50}
        className="self-start"
      >
        Save CV
      </Button>

      <Modal open={limitHit} onClose={() => setLimitHit(false)} title="CV limit reached">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-neutral-700">
            The free plan stores 1 CV. Replace{" "}
            <span className="font-medium">
              {replaceCv ? cvDisplayName(replaceCv) : "your existing CV"}
            </span>{" "}
            with this one, or upgrade to Pro for unlimited CVs.
          </p>
          <div className="flex flex-col gap-2">
            {replaceCv && (
              <Button
                loading={saving}
                onClick={() => {
                  setLimitHit(false);
                  void submit(replaceCv.id);
                }}
              >
                Replace existing CV
              </Button>
            )}
            <UpgradeButton />
          </div>
          <p className="text-xs text-neutral-500">
            Replacing deletes the old CV together with its analyses and job matches.
          </p>
        </div>
      </Modal>
    </div>
  );
}
