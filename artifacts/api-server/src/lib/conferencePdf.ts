import { Worker } from "node:worker_threads";

export const MAX_PDF_BYTES = 3_000_000;
export const MAX_PDF_PAGES = 24;
export const MAX_PDF_TEXT = 10_000;
const PDF_PARSE_TIMEOUT_MS = 12_000;

export class UnsupportedConferencePdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedConferencePdfError";
  }
}

// This runs in a disposable, memory-limited Node worker, not on the API event loop.
// Import the installed package by its resolved URL so the same code works from both
// the bundled server and source-level Vitest runs.
const PDF_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { PDFParse } = await import(workerData.moduleUrl);
  const parser = new PDFParse({ data: workerData.bytes });
  try {
    const info = await parser.getInfo();
    if (!Number.isInteger(info.total) || info.total < 1 || info.total > workerData.maxPages) {
      throw new Error("Public PDF exceeds the page research limit.");
    }
    let text = "";
    for (let page = 1; page <= info.total && text.length < workerData.maxText; page++) {
      const result = await parser.getText({ partial: [page] });
      text += " " + result.text.replace(/\\s+/g, " ");
    }
    text = text.trim().slice(0, workerData.maxText);
    if (text.length < 30) {
      throw new Error("The public PDF has no extractable text (it may be scanned or image-only).");
    }
    parentPort.postMessage({ text });
  } finally {
    await parser.destroy();
  }
})().catch((error) => {
  parentPort.postMessage({ error: error instanceof Error ? error.message : "Unparseable PDF." });
});
`;

/** Parse only bounded public PDF bytes, never ask the parser to fetch a URL. */
export async function extractConferencePdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_PDF_BYTES || bytes.byteLength < 8 ||
    new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new UnsupportedConferencePdfError("Public PDF is too large or has an invalid PDF signature.");
  }
  const copiedBytes = Uint8Array.from(bytes);
  let worker: Worker;
  try {
    worker = new Worker(PDF_WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: import.meta.resolve("pdf-parse"),
        bytes: copiedBytes,
        maxPages: MAX_PDF_PAGES,
        maxText: MAX_PDF_TEXT,
      },
      transferList: [copiedBytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
    });
  } catch {
    throw new UnsupportedConferencePdfError("Public PDF parser could not be started.");
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (value: string | null, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (value !== null) resolve(value);
      else reject(new UnsupportedConferencePdfError(message ?? "The public PDF is malformed or cannot be parsed safely."));
    };
    const timer = setTimeout(() => finish(null, "Public PDF text parsing timed out."), PDF_PARSE_TIMEOUT_MS);
    worker.on("message", (result: { text?: string; error?: string }) =>
      finish(result.text ?? null, result.error));
    worker.on("error", () => finish(null));
    worker.on("exit", (code) => finish(null, `Public PDF parser stopped unexpectedly (${code}).`));
  });
}