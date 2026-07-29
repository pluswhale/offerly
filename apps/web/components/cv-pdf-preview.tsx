"use client";

import { useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/modal";

// Worker served from /public (copied from pdfjs-dist@5.4.296); Turbopack
// cannot resolve the `new URL(..., import.meta.url)` asset form. Keep this
// file in sync when react-pdf upgrades its pinned pdfjs-dist version.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const PREVIEW_HEIGHT = 192; // px, matches h-48
const VIEWER_WIDTH = 600; // px, fits the wide modal (max-w-2xl minus padding)

/**
 * First-page preview of a PDF CV stored in the private `cvs` bucket, plus a
 * full-document viewer opened by clicking the preview. Rendered client-side
 * only: the signed URL is fetched after mount, so nothing pdfjs-related runs
 * during SSR.
 */
export function CvPdfPreview({ filePath, title }: { filePath: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .storage.from("cvs")
      .createSignedUrl(filePath, 3600)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data?.signedUrl) setFailed(true);
        else setUrl(data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <>
      {failed ? (
        <PreviewError />
      ) : !url ? (
        <PreviewLoading />
      ) : (
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          aria-label={`Open full CV: ${title}`}
          className="block h-48 w-full cursor-pointer overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 focus-visible:outline-accent-600"
        >
          <div className="pointer-events-none flex justify-center" aria-hidden="true">
            <Document
              file={url}
              loading={<PreviewLoading bare />}
              error={<PreviewError bare />}
              onLoadError={() => setFailed(true)}
            >
              <Page
                pageNumber={1}
                height={PREVIEW_HEIGHT}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                loading={<PreviewLoading bare />}
                error={<PreviewError bare />}
                onRenderError={() => setFailed(true)}
              />
            </Document>
          </div>
        </button>
      )}

      <Modal open={viewerOpen} onClose={() => setViewerOpen(false)} title={title} wide>
        {url && <CvViewer url={url} />}
      </Modal>
    </>
  );
}

/** Scrollable full-document view used inside the modal. */
function CvViewer({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0);

  return (
    <Document
      file={url}
      loading={<PreviewLoading label="Loading CV…" />}
      error={<PreviewError />}
      onLoadSuccess={({ numPages }) => setNumPages(numPages)}
    >
      <div className="flex flex-col items-center gap-4">
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i + 1}
            pageNumber={i + 1}
            width={VIEWER_WIDTH}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={<PreviewLoading bare />}
            error={<PreviewError bare />}
            className="overflow-hidden rounded-lg border border-neutral-200"
          />
        ))}
      </div>
    </Document>
  );
}

function PreviewLoading({ bare = false, label = "Loading preview…" }: { bare?: boolean; label?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={
        bare
          ? "h-48 w-full animate-pulse bg-neutral-200/70"
          : "flex h-48 w-full animate-pulse items-center justify-center rounded-lg border border-neutral-200 bg-neutral-200/70"
      }
    >
      {bare ? null : <span className="text-xs text-neutral-500">{label}</span>}
    </div>
  );
}

function PreviewError({ bare = false }: { bare?: boolean }) {
  return (
    <div
      role="alert"
      className={
        bare
          ? "flex h-48 w-full items-center justify-center bg-red-50"
          : "flex h-48 w-full items-center justify-center rounded-lg border border-red-200 bg-red-50"
      }
    >
      <span className="text-xs text-red-700">Preview unavailable</span>
    </div>
  );
}
