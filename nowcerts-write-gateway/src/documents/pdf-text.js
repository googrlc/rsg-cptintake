import { spawn } from "node:child_process";

export const MAX_EXTRACTED_PDF_CHARS = 500_000;

export async function extractPdfText(buffer, { command = process.env.PDFTOTEXT_BIN ?? "pdftotext", timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-layout", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    let outputBytes = 0;
    let errorText = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_EXTRACTED_PDF_CHARS * 4) output.push(chunk);
    });
    child.stderr.on("data", (chunk) => { errorText += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error("PDF text extraction timed out."));
      if (code !== 0) return reject(new Error(`PDF text extraction failed: ${errorText.trim() || `exit ${code}`}`));
      const text = Buffer.concat(output).toString("utf8").replace(/\u0000/g, "").trim();
      resolve({ text: text.slice(0, MAX_EXTRACTED_PDF_CHARS), truncated: text.length > MAX_EXTRACTED_PDF_CHARS });
    });
    child.stdin.end(buffer);
  });
}
