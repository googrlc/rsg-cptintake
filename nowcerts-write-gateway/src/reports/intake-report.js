import { spawn } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function generateIntakeReport(bundle, outputDir, { pythonBin = process.env.PYTHON_BIN ?? "python3", audience = "internal" } = {}) {
  if (bundle?.assessment?.status !== "COMPLETE") {
    throw Object.assign(new Error("Risk assessment must be complete before generating the PDF."), { statusCode: 409 });
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const suffix = audience === "client" ? "client-review" : "risk-assessment";
  const outputPath = path.resolve(outputDir, `${bundle.intake_id}-${suffix}.pdf`);
  const scriptPath = path.resolve(import.meta.dirname, "../../scripts/render-intake-report.py");

  await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, outputPath, audience], { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PDF generation failed: ${errorText.trim() || `exit ${code}`}`));
    });
    child.stdin.end(JSON.stringify(bundle));
  });

  await chmod(outputPath, 0o600);
  return { path: outputPath, bytes: await readFile(outputPath) };
}

