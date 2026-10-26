import { err, ok, type Result } from "../../../core/result.ts";
import { type AppError, appError } from "../../application/app-error.ts";
import { runProcess } from "../system/process-runner.ts";

/** A global npm install downloads the package and its dependencies; slow networks need minutes. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The UI shows the end of npm's output, where the result and any error are. */
const MAX_OUTPUT_CHARS = 8 * 1024;
// Colors plus the cursor and line codes npm uses to draw its progress spinner.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

export type SelfUpdateResult = { output: string };

/** Runs `npm install -g portless-studio`; `npmBin` is configurable so tests never touch real npm. */
export async function installSelfUpdate(
  npmBin: string,
): Promise<Result<SelfUpdateResult, AppError>> {
  const outcome = await runProcess(npmBin, ["install", "-g", "portless-studio"], {
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  const raw = outcome.error ?? outcome.combined;
  const output = lastChars(stripAnsi(raw).trim(), MAX_OUTPUT_CHARS);
  if (outcome.missing) {
    return err(
      appError("install_failed", `Could not run "${npmBin}". Install Node.js, which includes npm.`),
    );
  }
  if (outcome.exitCode === 0) return ok({ output });
  const reason =
    outcome.exitCode === null
      ? "npm did not finish in 5 minutes."
      : `npm exited with code ${outcome.exitCode}.`;
  return err(appError("install_failed", output === "" ? reason : `${reason}\n\n${output}`));
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

function lastChars(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}
