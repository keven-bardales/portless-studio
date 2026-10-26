import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installSelfUpdate } from "./self-update.ts";

// Stands in for npm: accepts only `install -g portless-studio`.
const fakeNpm = (mode: "ok" | "fail") => `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args !== "install -g portless-studio") {
  console.error("unexpected arguments: " + args);
  process.exit(2);
}
if (${JSON.stringify(mode)} === "fail") {
  console.log("npm http fetch GET 200 https://registry.npmjs.org/portless-studio");
  console.error("\u001b[31mnpm error\u001b[39m code EACCES");
  process.exit(243);
}
console.log("added 1 package in 2s");
`;

const posixOnly = process.platform === "win32" ? it.skip : it;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-studio-self-update-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeNpmBin(mode: "ok" | "fail"): string {
  const bin = path.join(dir, "fake-npm.cjs");
  fs.writeFileSync(bin, fakeNpm(mode), { mode: 0o755 });
  return bin;
}

describe("installSelfUpdate", () => {
  posixOnly("runs npm install -g portless-studio and returns its output", async () => {
    const result = await installSelfUpdate(fakeNpmBin("ok"));
    expect(result).toEqual({ ok: true, value: { output: "added 1 package in 2s" } });
  });

  posixOnly("returns install_failed with npm's output, without color codes", async () => {
    const result = await installSelfUpdate(fakeNpmBin("fail"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("install_failed");
    expect(result.error.message).toContain("exited with code 243");
    expect(result.error.message).toContain("npm http fetch GET 200");
    expect(result.error.message).toContain("npm error code EACCES");
    expect(result.error.message).not.toContain("\u001b");
  });

  it("returns install_failed when npm cannot be found", async () => {
    const result = await installSelfUpdate(path.join(dir, "no-such-npm"));
    expect(result).toMatchObject({ ok: false, error: { code: "install_failed" } });
    expect(result.ok ? "" : result.error.message).toContain("Install Node.js");
  });
});
