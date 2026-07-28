import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/**
 * Server-side text extraction (T5.1). PDF via pdf-parse, DOCX via mammoth.
 * Returns the raw text; the caller detects scanned PDFs (empty result).
 */
export async function extractText(buffer: Buffer, filename: string): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  throw new Error(`Unsupported file type: ${filename}`);
}
