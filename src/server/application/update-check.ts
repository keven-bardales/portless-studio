import type { UpdateInstallResponse, UpdateStatus } from "../../core/api/contract.ts";
import { err, ok, type Result } from "../../core/result.ts";
import { isNewerVersion, UPDATE_COMMAND } from "../../core/updates/version.ts";
import { type AppError, appError } from "./app-error.ts";

/** When Studio last asked npm, and what it answered (null when the request failed). */
export type UpdateCache = { checkedAt: number; latest: string | null };

/** Keeps the last check between runs, so Studio asks npm at most once a day. */
export interface UpdateCacheStore {
  read(): UpdateCache | null;
  write(cache: UpdateCache): void;
}

export type UpdateCheckerOptions = {
  /** The version this Studio runs. */
  current: string;
  /** Read on every call, so turning `checkForUpdates` off in Settings stops the next check. */
  enabled: () => Promise<boolean>;
  /** The latest published version; may throw or return null when npm cannot be reached. */
  fetchLatest: () => Promise<string | null>;
  cache: UpdateCacheStore;
  now?: () => number;
  /** Runs `npm install -g portless-studio`; omitted where Studio cannot install updates itself. */
  install?: () => Promise<Result<{ output: string }, AppError>>;
};

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Says whether a newer portless-studio is on npm, asking the registry at most once a day. */
export class UpdateChecker {
  readonly #options: UpdateCheckerOptions;
  readonly #now: () => number;
  #pending: Promise<string | null> | null = null;
  #installing = false;

  constructor(options: UpdateCheckerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs `npm install -g portless-studio` for the version `status()` last reported as available.
   * Refuses with `install_in_progress` while another install runs, `invalid_request` when no
   * newer version is known, and `install_failed` (carrying `UPDATE_COMMAND` to run by hand
   * instead) when npm itself fails.
   */
  async install(): Promise<Result<UpdateInstallResponse, AppError>> {
    if (!this.#options.install) {
      return err(appError("unsupported", "Studio cannot install updates on this backend."));
    }
    if (this.#installing) {
      return err(appError("install_in_progress", "An update is already installing."));
    }
    // Set before the first `await`: two calls arriving back to back must never both pass the
    // check above and both start npm.
    this.#installing = true;
    try {
      const status = await this.status();
      if (!status.available || status.latest === null) {
        return err(appError("invalid_request", "No newer version is available."));
      }
      const latest = status.latest;
      const installed = await this.#options.install();
      if (!installed.ok) {
        return err(appError(installed.error.code, installed.error.message, UPDATE_COMMAND));
      }
      return ok({ version: latest, output: installed.value.output });
    } finally {
      this.#installing = false;
    }
  }

  async status(): Promise<UpdateStatus> {
    const { current } = this.#options;
    const latest = (await this.#options.enabled()) ? await this.#latest() : null;
    return {
      current,
      latest,
      available: latest !== null && isNewerVersion(latest, current),
      command: UPDATE_COMMAND,
    };
  }

  #latest(): Promise<string | null> {
    const cached = this.#readCache();
    const now = this.#now();
    if (cached && cached.checkedAt <= now && now - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
      return Promise.resolve(cached.latest);
    }
    this.#pending ??= this.#check(cached).finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #check(cached: UpdateCache | null): Promise<string | null> {
    const latest = await this.#options.fetchLatest().catch(() => null);
    // A failed request is written down too, so an offline machine does not retry on every start.
    const entry = { checkedAt: this.#now(), latest: latest ?? cached?.latest ?? null };
    try {
      this.#options.cache.write(entry);
    } catch {
      // The notice is optional; a read-only config folder only means asking again next time.
    }
    return entry.latest;
  }

  #readCache(): UpdateCache | null {
    try {
      return this.#options.cache.read();
    } catch {
      return null;
    }
  }
}

/**
 * Update checks never run in CI or tests, and `PORTLESS_STUDIO_NO_UPDATE_CHECK=1` turns them off
 * whatever the config says.
 */
export function updateChecksAllowed(env: Record<string, string | undefined>): boolean {
  if (env.PORTLESS_STUDIO_NO_UPDATE_CHECK === "1") return false;
  if (env.CI) return false;
  if (env.VITEST) return false;
  return true;
}
