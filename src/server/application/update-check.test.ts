import type { Result } from "../../core/result.ts";
import type { AppError } from "./app-error.ts";
import {
  type UpdateCache,
  type UpdateCacheStore,
  UpdateChecker,
  updateChecksAllowed,
} from "./update-check.ts";

const DAY = 24 * 60 * 60 * 1000;

function memoryCache(initial: UpdateCache | null = null): UpdateCacheStore & {
  value: UpdateCache | null;
} {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(cache) {
      this.value = cache;
    },
  };
}

function checker(options: {
  latest?: () => Promise<string | null>;
  cache?: UpdateCacheStore;
  enabled?: boolean;
  now?: number;
  install?: () => Promise<Result<{ output: string }, AppError>>;
}) {
  const fetchLatest = vi.fn(options.latest ?? (async () => "0.2.0"));
  const install = options.install ? vi.fn(options.install) : undefined;
  const instance = new UpdateChecker({
    current: "0.1.0",
    enabled: async () => options.enabled ?? true,
    fetchLatest,
    cache: options.cache ?? memoryCache(),
    now: () => options.now ?? 10 * DAY,
    ...(install ? { install } : {}),
  });
  return { instance, fetchLatest, install };
}

describe("UpdateChecker", () => {
  it("reports a newer version from the registry and caches it with the time", async () => {
    const cache = memoryCache();
    const { instance } = checker({ cache });
    expect(await instance.status()).toEqual({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      command: "npm i -g portless-studio",
    });
    expect(cache.value).toEqual({ checkedAt: 10 * DAY, latest: "0.2.0" });
  });

  it("does not ask the registry again within a day", async () => {
    const cache = memoryCache({ checkedAt: 10 * DAY - DAY + 1000, latest: "0.3.0" });
    const { instance, fetchLatest } = checker({ cache });
    expect((await instance.status()).latest).toBe("0.3.0");
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("asks again once the cached check is a day old", async () => {
    const cache = memoryCache({ checkedAt: 9 * DAY, latest: "0.1.5" });
    const { instance, fetchLatest } = checker({ cache });
    expect((await instance.status()).latest).toBe("0.2.0");
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("runs one request for calls that overlap and remembers its answer", async () => {
    const { instance, fetchLatest } = checker({});
    await Promise.all([instance.status(), instance.status()]);
    await instance.status();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("says nothing is available when the running version is the latest", async () => {
    const { instance } = checker({ latest: async () => "0.1.0" });
    expect(await instance.status()).toMatchObject({ latest: "0.1.0", available: false });
  });

  it("ignores a failed request and does not retry it before a day passes", async () => {
    const cache = memoryCache();
    const { instance, fetchLatest } = checker({
      cache,
      latest: async () => {
        throw new Error("offline");
      },
    });
    expect(await instance.status()).toMatchObject({ latest: null, available: false });
    expect(cache.value).toEqual({ checkedAt: 10 * DAY, latest: null });
    await instance.status();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("never asks the registry while checks are off", async () => {
    const { instance, fetchLatest } = checker({ enabled: false });
    expect(await instance.status()).toMatchObject({ latest: null, available: false });
    expect(fetchLatest).not.toHaveBeenCalled();
  });
});

describe("UpdateChecker.install", () => {
  it("runs the injected install and reports the version it was told was latest", async () => {
    const { instance, install } = checker({
      install: async () => ({ ok: true, value: { output: "added 1 package in 2s" } }),
    });
    expect(await instance.install()).toEqual({
      ok: true,
      value: { version: "0.2.0", output: "added 1 package in 2s" },
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("refuses when no newer version is available, without running install", async () => {
    const { instance, install } = checker({
      latest: async () => "0.1.0",
      install: async () => ({ ok: true, value: { output: "" } }),
    });
    expect(await instance.install()).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses when this backend cannot install updates", async () => {
    const { instance } = checker({});
    expect(await instance.install()).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("carries the update command to run by hand when npm fails", async () => {
    const { instance } = checker({
      install: async () => ({
        ok: false,
        error: { code: "install_failed", message: "npm exited with code 243." },
      }),
    });
    expect(await instance.install()).toEqual({
      ok: false,
      error: {
        code: "install_failed",
        message: "npm exited with code 243.",
        command: "npm i -g portless-studio",
      },
    });
  });

  it("rejects a second install while one is running", async () => {
    let calls = 0;
    const { instance } = checker({
      install: async () => {
        calls += 1;
        return { ok: true, value: { output: "" } };
      },
    });
    const first = instance.install();
    const second = await instance.install();
    expect(second).toMatchObject({ ok: false, error: { code: "install_in_progress" } });
    expect((await first).ok).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("updateChecksAllowed", () => {
  it("allows checks in an ordinary shell", () => {
    expect(updateChecksAllowed({})).toBe(true);
  });

  it("turns them off in CI, in tests and with PORTLESS_STUDIO_NO_UPDATE_CHECK=1", () => {
    expect(updateChecksAllowed({ CI: "true" })).toBe(false);
    expect(updateChecksAllowed({ CI: "1" })).toBe(false);
    expect(updateChecksAllowed({ VITEST: "true" })).toBe(false);
    expect(updateChecksAllowed({ PORTLESS_STUDIO_NO_UPDATE_CHECK: "1" })).toBe(false);
  });

  it("treats an empty CI variable as not set", () => {
    expect(updateChecksAllowed({ CI: "" })).toBe(true);
  });
});
