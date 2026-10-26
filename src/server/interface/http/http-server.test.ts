import * as fs from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  API_PATHS,
  type InstallPortlessResponse,
  type Snapshot,
  TOKEN_HEADER,
  type UpdateInstallResponse,
} from "../../../core/api/contract.ts";
import { DEFAULT_CONFIG } from "../../../core/config/studio-config.ts";
import type { DoctorCheck } from "../../../core/doctor/doctor-check.ts";
import type { CustomApp } from "../../../core/projects/custom-app.ts";
import { err, ok, type Result } from "../../../core/result.ts";
import type { Route } from "../../../core/routes/route.ts";
import type { AppError } from "../../application/app-error.ts";
import { OpenWith } from "../../application/open-with.ts";
import type { ListeningPort, PortScanner } from "../../application/port-scanner.ts";
import type { PortlessState, RouteRegistry } from "../../application/route-registry.ts";
import { StudioRuntime } from "../../application/studio-runtime.ts";
import type { PreparedStudioAction } from "../../application/studio-service.ts";
import { JsonConfigStore } from "../../infrastructure/config/json-config-store.ts";
import { createHttpServer, type HttpServer } from "./http-server.ts";

const TOKEN = "test-token";

const alias: Route = {
  hostname: "db.localhost",
  name: "db",
  port: 5432,
  kind: "alias",
  pid: null,
  registeredAt: null,
  url: "http://db.localhost:1355",
  tunnels: [],
};

function fakeRegistry() {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  let routes: Route[] = [alias];
  const install: { result: Result<InstallPortlessResponse, AppError> } = {
    result: ok({ version: "1.2.3", output: "added 1 package" }),
  };
  const registry: RouteRegistry = {
    readSnapshot: async (): Promise<PortlessState> => ({
      proxy: { running: true, port: 1355, https: false, tlds: ["localhost"] },
      portless: { installed: false, version: null },
      routes,
      readAt: 1,
    }),
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    createAlias: async (name, port, force) => {
      calls.push(`create ${name} ${port} ${force}`);
      return ok(undefined);
    },
    removeAlias: async (name) => {
      calls.push(`remove ${name}`);
      return ok(undefined);
    },
    startProxy: async () => ok(undefined),
    stopProxy: async () => ok(undefined),
    proxyPid: async () => null,
    installPortless: async () => {
      calls.push("install");
      return install.result;
    },
  };
  const change = (next: Route[]) => {
    routes = next;
    for (const listener of listeners) listener();
  };
  return { registry, calls, change, listeners, install };
}

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

let http: HttpServer;
let port: number;
let webDir: string;
let fake: ReturnType<typeof fakeRegistry>;
let configDir: string;
let configFile: string;
let ops: ReturnType<typeof fakeOperations>;
let runtime: StudioRuntime;

const CHECK: DoctorCheck = {
  id: "proxy-running",
  status: "warn",
  title: "The proxy is not running",
  detail: "Names do not open until it runs.",
  fix: { label: "Start the proxy on port 1355", action: "start-proxy" },
};

/** Doctor, proxy, Studio and process operations, recording what the server asks of them. */
function fakeOperations() {
  const calls: string[] = [];
  const state = {
    calls,
    proxyResult: ok("Stopped the proxy.") as Result<string, AppError>,
    studioResult: null as Result<PreparedStudioAction, AppError> | null,
    stopResult: ok({ pid: 51, port: 5173 }) as Result<{ pid: number; port: number }, AppError>,
    updateInstallResult: ok({ version: "0.2.0", output: "added 1 package" }) as Result<
      UpdateInstallResponse,
      AppError
    >,
  };
  return {
    state,
    options: {
      doctor: {
        check: async () => [CHECK],
        fix: async (id: string) => {
          calls.push(`fix ${id}`);
          return ok({ message: "Started the proxy on port 1355.", checks: [] });
        },
      },
      controlProxy: async (action: string) => {
        calls.push(`proxy ${action}`);
        return state.proxyResult;
      },
      studioService: {
        status: async () => null,
        prepare: async (action: string) => {
          calls.push(`prepare ${action}`);
          return (
            state.studioResult ??
            ok({
              message: "Studio is stopping.",
              startCommand: "portless-studio",
              run: async () => {
                calls.push(`run ${action}`);
              },
            })
          );
        },
      },
      stopProcess: async (pid: string, all?: boolean) => {
        calls.push(`stop ${pid}${all ? " tree" : ""}`);
        return state.stopResult;
      },
      stopContainer: async (name: string) => {
        calls.push(`stop container ${name}`);
        return state.stopResult;
      },
      updates: {
        status: async () => ({
          current: "0.1.0",
          latest: "0.2.0",
          available: true,
          command: "npm i -g portless-studio",
        }),
        install: async () => {
          calls.push("update install");
          return state.updateInstallResult;
        },
      },
    },
  };
}

const devServer: ListeningPort = { port: 5173, pid: 51, processName: "node", cwd: "/code/app" };
const scanner: PortScanner = { scan: async () => [devServer], answersHttp: async () => true };

async function start(withWeb = true) {
  fake = fakeRegistry();
  const operations = fakeOperations();
  ops = operations;
  const studio = new StudioRuntime({
    registry: fake.registry,
    scanner,
    configStore: new JsonConfigStore(configFile),
    projects: {
      read: () => ({ packageName: "app", repoName: null, folderName: "app", worktreeName: null }),
    },
    log: () => {},
  });
  runtime = studio;
  let customApps: CustomApp[] = [];
  const openWith = new OpenWith({
    catalog: {
      installed: async () => [
        { id: "zed", name: "Zed", kind: "editor", command: { file: "zed", args: ["{path}"] } },
      ],
    },
    launcher: {
      launch: async (command) => {
        operations.state.calls.push(`launch ${command.file} ${command.args.join(" ")}`);
        return ok(undefined);
      },
    },
    customApps: {
      path: "/cfg/open-with.json",
      read: async () => customApps,
      write: async (apps) => {
        customApps = apps;
      },
    },
    openableFolders: () => studio.openableFolders(),
  });
  http = createHttpServer({
    registry: fake.registry,
    studio,
    token: TOKEN,
    webDir: withWeb ? webDir : undefined,
    openWith,
    ...operations.options,
  });
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  port = (http.server.address() as AddressInfo).port;
}

function send(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path: pathname, headers, setHost: !("host" in headers) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const json = (reply: Reply): unknown => JSON.parse(reply.body.toString());
const write = { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" };

beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-studio-"));
  configFile = path.join(configDir, "config.json");
  webDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-studio-"));
  fs.mkdirSync(path.join(webDir, "assets"));
  fs.writeFileSync(path.join(webDir, "index.html"), `<!doctype html><title>Studio</title>`);
  fs.writeFileSync(path.join(webDir, "assets", "app-1a2b.js"), `console.log(1);\n`.repeat(200));
  await start();
});

afterEach(async () => {
  http.closeStreams();
  http.server.closeAllConnections();
  await new Promise((resolve) => http.server.close(resolve));
  fs.rmSync(webDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("API reads", () => {
  it("returns the snapshot as JSON", async () => {
    const reply = await send("GET", API_PATHS.snapshot);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toContain("application/json");
    expect(json(reply)).toMatchObject({
      routes: [{ name: "db" }],
      proxy: { port: 1355 },
      portless: { installed: false, version: null },
    });
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("hides Studio's own route unless the request asks for it with includeStudio", async () => {
    runtime.setStudioPort(alias.port);
    expect(json(await send("GET", API_PATHS.snapshot))).toMatchObject({ routes: [] });
    expect(json(await send("GET", `${API_PATHS.snapshot}?includeStudio=1`))).toMatchObject({
      routes: [{ name: "db" }],
    });
  });

  it("returns the session token to a same-origin request", async () => {
    const reply = await send("GET", API_PATHS.session, { origin: `http://127.0.0.1:${port}` });
    expect(json(reply)).toEqual({ token: TOKEN });
  });

  it("answers unknown API paths with not_found", async () => {
    const reply = await send("GET", "/api/nope");
    expect(reply.status).toBe(404);
    expect(json(reply)).toMatchObject({ error: "not_found" });
  });
});

describe("update notice", () => {
  it("says whether a newer version exists, without the token", async () => {
    const reply = await send("GET", API_PATHS.update);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      command: "npm i -g portless-studio",
    });
  });

  it("is read-only", async () => {
    expect((await send("POST", API_PATHS.update, write)).status).toBe(404);
  });

  it("rejects an install without the token and does not run it", async () => {
    const reply = await send("POST", API_PATHS.updateInstall);
    expect(reply.status).toBe(403);
    expect(json(reply)).toMatchObject({ error: "forbidden" });
    expect(ops.state.calls).toEqual([]);
  });

  it("runs the update and returns the version and output", async () => {
    const reply = await send("POST", API_PATHS.updateInstall, write);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ version: "0.2.0", output: "added 1 package" });
    expect(ops.state.calls).toEqual(["update install"]);
  });

  it("returns install_failed with the command to run by hand", async () => {
    ops.state.updateInstallResult = err({
      code: "install_failed",
      message: "npm exited with code 243.",
      command: "npm i -g portless-studio",
    });
    const reply = await send("POST", API_PATHS.updateInstall, write);
    expect(reply.status).toBe(502);
    expect(json(reply)).toEqual({
      error: "install_failed",
      message: "npm exited with code 243.",
      command: "npm i -g portless-studio",
    });
  });

  it("does not install on GET", async () => {
    const reply = await send("GET", API_PATHS.updateInstall);
    expect(reply.status).toBe(404);
    expect(ops.state.calls).toEqual([]);
  });
});

describe("guards", () => {
  it("rejects a foreign Host", async () => {
    const reply = await send("GET", API_PATHS.snapshot, { host: "evil.example:80" });
    expect(reply.status).toBe(403);
    expect(json(reply)).toMatchObject({ error: "forbidden" });
  });

  it("accepts a .localhost Host", async () => {
    const reply = await send("GET", API_PATHS.snapshot, { host: "studio.localhost:1355" });
    expect(reply.status).toBe(200);
  });

  it("rejects a foreign Origin, even for reads", async () => {
    const reply = await send("GET", API_PATHS.session, { origin: "http://evil.example" });
    expect(reply.status).toBe(403);
  });

  it("rejects a write without the token and does not touch the registry", async () => {
    const reply = await send("POST", API_PATHS.aliases, {}, JSON.stringify({ name: "x", port: 1 }));
    expect(reply.status).toBe(403);
    expect(json(reply)).toMatchObject({ error: "forbidden" });
    expect(fake.calls).toEqual([]);
  });

  it("rejects a write with a wrong token", async () => {
    const reply = await send("DELETE", API_PATHS.alias("db"), { [TOKEN_HEADER]: "nope" });
    expect(reply.status).toBe(403);
    expect(fake.calls).toEqual([]);
  });
});

describe("API writes", () => {
  it("creates an alias", async () => {
    const body = JSON.stringify({ name: "web", port: 3000 });
    const reply = await send("POST", API_PATHS.aliases, write, body);
    expect(reply.status).toBe(201);
    expect(fake.calls).toEqual(["create web 3000 false"]);
  });

  it("returns invalid_port as 400", async () => {
    const body = JSON.stringify({ name: "web", port: "abc" });
    const reply = await send("POST", API_PATHS.aliases, write, body);
    expect(reply.status).toBe(400);
    expect(json(reply)).toMatchObject({ error: "invalid_port" });
  });

  it("renames an alias", async () => {
    const body = JSON.stringify({ name: "pg" });
    const reply = await send("PATCH", API_PATHS.alias("db"), write, body);
    expect(reply.status).toBe(204);
    expect(fake.calls).toEqual(["create pg 5432 false", "remove db"]);
  });

  it("removes an alias and reports an unknown one as 404", async () => {
    expect((await send("DELETE", API_PATHS.alias("db"), write)).status).toBe(204);
    const missing = await send("DELETE", API_PATHS.alias("nope"), write);
    expect(missing.status).toBe(404);
    expect(fake.calls).toEqual(["remove db"]);
  });

  it("rejects a body over 16 KB with 413", async () => {
    const body = JSON.stringify({ name: "x".repeat(20_000), port: 1 });
    const reply = await send("POST", API_PATHS.aliases, write, body);
    expect(reply.status).toBe(413);
    expect(fake.calls).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const reply = await send("POST", API_PATHS.aliases, write, "{nope");
    expect(reply.status).toBe(400);
    expect(json(reply)).toMatchObject({ error: "invalid_request" });
  });
});

describe("doctor", () => {
  it("returns the checks without a token", async () => {
    const reply = await send("GET", API_PATHS.doctor);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ checks: [CHECK] });
  });

  it("runs a fix only with the token", async () => {
    expect((await send("POST", API_PATHS.doctorFix("proxy-running"))).status).toBe(403);
    const reply = await send("POST", API_PATHS.doctorFix("proxy-running"), write);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ message: "Started the proxy on port 1355.", checks: [] });
    expect(ops.state.calls).toEqual(["fix proxy-running"]);
  });
});

describe("proxy and Studio control", () => {
  it("stops the proxy with the token and answers with what happened", async () => {
    expect((await send("POST", API_PATHS.proxy("stop"))).status).toBe(403);
    const reply = await send("POST", API_PATHS.proxy("stop"), write);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ message: "Stopped the proxy." });
    expect(ops.state.calls).toEqual(["proxy stop"]);
  });

  it("returns the sudo command when the proxy belongs to root", async () => {
    ops.state.proxyResult = err({
      code: "needs_admin",
      message: "The proxy runs as root (pid 1), so stopping it needs sudo.",
      command: "sudo portless proxy stop",
    });
    const reply = await send("POST", API_PATHS.proxy("restart"), write);
    expect(reply.status).toBe(409);
    expect(json(reply)).toMatchObject({
      error: "needs_admin",
      command: "sudo portless proxy stop",
    });
  });

  it("rejects an unknown proxy action", async () => {
    const reply = await send("POST", "/api/proxy/explode", write);
    expect(reply.status).toBe(404);
    expect(ops.state.calls).toEqual([]);
  });

  it("answers a Studio stop before running it", async () => {
    expect((await send("POST", API_PATHS.studio("stop"))).status).toBe(403);
    const reply = await send("POST", API_PATHS.studio("stop"), write);
    expect(reply.status).toBe(202);
    expect(json(reply)).toEqual({
      message: "Studio is stopping.",
      startCommand: "portless-studio",
    });
    await vi.waitFor(() => expect(ops.state.calls).toEqual(["prepare stop", "run stop"]));
  });

  it("passes on a Studio action this system cannot do", async () => {
    ops.state.studioResult = err({
      code: "unsupported",
      message: "Windows cannot restart Studio.",
    });
    const reply = await send("POST", API_PATHS.studio("restart"), write);
    expect(reply.status).toBe(501);
    expect(ops.state.calls).toEqual(["prepare restart"]);
  });
});

describe("stopping a dev server", () => {
  it("needs the token", async () => {
    expect((await send("POST", API_PATHS.stopProcess(51))).status).toBe(403);
    expect(ops.state.calls).toEqual([]);
  });

  it("stops the process and answers 204", async () => {
    const reply = await send("POST", API_PATHS.stopProcess(51), write);
    expect(reply.status).toBe(204);
    expect(ops.state.calls).toEqual(["stop 51"]);
  });

  it("passes the explicitly requested tree scope", async () => {
    const reply = await send("POST", `${API_PATHS.stopProcess(51)}?scope=tree`, write);
    expect(reply.status).toBe(204);
    expect(ops.state.calls).toEqual(["stop 51 tree"]);
  });

  it("returns process_not_allowed as 403 with the message", async () => {
    ops.state.stopResult = err({ code: "process_not_allowed", message: "Not yours." });
    const reply = await send("POST", API_PATHS.stopProcess(1), write);
    expect(reply.status).toBe(403);
    expect(json(reply)).toMatchObject({ error: "process_not_allowed", message: "Not yours." });
  });
});

describe("stopping a container", () => {
  it("needs the token", async () => {
    expect((await send("POST", API_PATHS.stopContainer("acme-api-1"))).status).toBe(403);
    expect(ops.state.calls).toEqual([]);
  });

  it("stops the container by name and answers 204", async () => {
    const reply = await send("POST", API_PATHS.stopContainer("acme-api-1"), write);
    expect(reply.status).toBe(204);
    expect(ops.state.calls).toEqual(["stop container acme-api-1"]);
  });
});

describe("open with", () => {
  const body = (appId: string, folder: string) => JSON.stringify({ appId, path: folder });

  it("lists the apps without the token", async () => {
    const reply = await send("GET", API_PATHS.openWithApps);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ apps: [{ id: "zed", name: "Zed", kind: "editor" }] });
  });

  it("opens the folder of a detected port with the token", async () => {
    expect((await send("POST", API_PATHS.openWith, {}, body("zed", "/code/app"))).status).toBe(403);
    expect(ops.state.calls).toEqual([]);
    const reply = await send("POST", API_PATHS.openWith, write, body("zed", "/code/app"));
    expect(reply.status).toBe(204);
    expect(ops.state.calls).toEqual(["launch zed /code/app"]);
  });

  it("refuses folders Studio does not show and apps it does not know", async () => {
    const outside = await send("POST", API_PATHS.openWith, write, body("zed", "/etc"));
    expect(outside.status).toBe(403);
    expect(json(outside)).toMatchObject({ error: "path_not_allowed" });
    const unknown = await send("POST", API_PATHS.openWith, write, body("vim", "/code/app"));
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toMatchObject({ error: "unknown_app" });
    expect(ops.state.calls).toEqual([]);
  });

  it("reads and replaces the custom apps; the write needs the token", async () => {
    const apps = JSON.stringify({ apps: [{ name: "Helix", command: "foot hx {path}" }] });
    expect((await send("PUT", API_PATHS.customApps, {}, apps)).status).toBe(403);
    const saved = await send("PUT", API_PATHS.customApps, write, apps);
    expect(saved.status).toBe(200);
    const read = await send("GET", API_PATHS.customApps);
    expect(json(read)).toEqual({
      apps: [{ name: "Helix", command: "foot hx {path}" }],
      path: "/cfg/open-with.json",
    });
    const broken = JSON.stringify({ apps: [{ name: "x", command: "" }] });
    expect((await send("PUT", API_PATHS.customApps, write, broken)).status).toBe(400);
  });
});

describe("detected ports and config", () => {
  it("includes detected ports and auto mode in the snapshot", async () => {
    const snapshot = json(await send("GET", API_PATHS.snapshot)) as Snapshot;
    expect(snapshot.autoName).toBe(false);
    expect(snapshot.detected).toEqual([
      {
        ...devServer,
        suggestedName: "app",
        project: { name: "app", worktree: null, branch: null, path: "/code/app" },
      },
    ]);
  });

  it("returns the config and its path", async () => {
    const reply = await send("GET", API_PATHS.config);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ config: DEFAULT_CONFIG, path: configFile });
  });

  it("requires the token to change the config", async () => {
    const reply = await send("PUT", API_PATHS.config, {}, JSON.stringify({ autoName: true }));
    expect(reply.status).toBe(403);
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("writes a valid config and returns it", async () => {
    const body = JSON.stringify({ ...DEFAULT_CONFIG, autoName: true });
    const reply = await send("PUT", API_PATHS.config, write, body);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({
      config: { ...DEFAULT_CONFIG, autoName: true },
      path: configFile,
    });
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).autoName).toBe(true);
    expect((json(await send("GET", API_PATHS.snapshot)) as Snapshot).autoName).toBe(true);
  });

  it("rejects an invalid config with invalid_config as 400", async () => {
    const reply = await send("PUT", API_PATHS.config, write, JSON.stringify({ port: 0 }));
    expect(reply.status).toBe(400);
    expect(json(reply)).toMatchObject({
      error: "invalid_config",
      message: expect.stringContaining('"port"'),
    });
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("ignores a detected port", async () => {
    expect((await send("POST", API_PATHS.ignoreDetected(5173))).status).toBe(403);
    const reply = await send("POST", API_PATHS.ignoreDetected(5173), write);
    expect(reply.status).toBe(204);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).ignoredPorts).toEqual([5173]);
    expect((json(await send("GET", API_PATHS.snapshot)) as Snapshot).detected).toEqual([]);
    const bad = await send("POST", "/api/detected/abc/ignore", write);
    expect(bad.status).toBe(400);
    expect(json(bad)).toMatchObject({ error: "invalid_port" });
  });
});

describe("portless install", () => {
  it("rejects an install without the token and does not run it", async () => {
    const reply = await send("POST", API_PATHS.installPortless);
    expect(reply.status).toBe(403);
    expect(json(reply)).toMatchObject({ error: "forbidden" });
    expect(fake.calls).toEqual([]);
  });

  it("runs the install and returns the version and output", async () => {
    const reply = await send("POST", API_PATHS.installPortless, write);
    expect(reply.status).toBe(200);
    expect(json(reply)).toEqual({ version: "1.2.3", output: "added 1 package" });
    expect(fake.calls).toEqual(["install"]);
  });

  it("returns install_failed as 502 with npm's output", async () => {
    fake.install.result = err({
      code: "install_failed",
      message: "npm exited with code 1.\n\nEACCES",
    });
    const reply = await send("POST", API_PATHS.installPortless, write);
    expect(reply.status).toBe(502);
    expect(json(reply)).toEqual({
      error: "install_failed",
      message: "npm exited with code 1.\n\nEACCES",
    });
  });

  it("returns install_in_progress as 409", async () => {
    fake.install.result = err({ code: "install_in_progress", message: "Already installing." });
    const reply = await send("POST", API_PATHS.installPortless, write);
    expect(reply.status).toBe(409);
    expect(json(reply)).toMatchObject({ error: "install_in_progress" });
  });

  it("does not install on GET", async () => {
    const reply = await send("GET", API_PATHS.installPortless);
    expect(reply.status).toBe(404);
    expect(fake.calls).toEqual([]);
  });
});

describe("events", () => {
  it("sends the snapshot on connect and after a change", async () => {
    const received: string[] = [];
    const done = new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: API_PATHS.events }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.on("data", (chunk: Buffer) => {
          received.push(chunk.toString());
          if (received.length === 1) fake.change([]);
          if (received.length === 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.end();
    });
    await done;
    expect(received[0]).toMatch(/^event: snapshot\ndata: \{.*"name":"db".*\}\n\n$/);
    expect(received[1]).toContain('"routes":[]');
    await vi.waitFor(() => expect(fake.listeners.size).toBe(0));
  });

  it("sends notable changes as event messages and replays them to a page that connects later", async () => {
    const stream = (onChunk: (text: string, stop: () => void) => void) =>
      new Promise<string>((resolve) => {
        let all = "";
        const req = request({ host: "127.0.0.1", port, path: API_PATHS.events }, (res) => {
          res.on("data", (chunk: Buffer) => {
            all += chunk.toString();
            onChunk(all, () => {
              req.destroy();
              resolve(all);
            });
          });
        });
        req.end();
      });

    let changed = false;
    const first = await stream((all, stop) => {
      if (!changed) {
        changed = true;
        fake.change([]);
      }
      if (all.includes("event: event\n")) stop();
    });
    const message = /event: event\ndata: (.*)\n\n/.exec(first)?.[1] ?? "null";
    expect(JSON.parse(message)).toMatchObject({
      kind: "removed",
      title: "Removed db",
      target: { port: 5432 },
    });
    // The snapshot without the route arrives before the event that talks about it.
    expect(first.lastIndexOf("event: snapshot")).toBeLessThan(first.indexOf("event: event"));

    const later = await stream((all, stop) => {
      if (all.includes("event: event\n")) stop();
    });
    expect(later.indexOf("event: snapshot")).toBe(0);
    expect(later).toContain('"title":"Removed db"');
  });
});

describe("static files", () => {
  it("serves index.html for app paths with no-cache and security headers", async () => {
    const reply = await send("GET", "/settings/routes");
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toContain("<title>Studio</title>");
    expect(reply.headers["cache-control"]).toBe("no-cache");
    expect(reply.headers["content-security-policy"]).toContain("default-src 'self'");
    // The terminal (xterm.js) paints ANSI colors through <style> elements it creates at runtime.
    expect(reply.headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
    expect(reply.headers["content-security-policy"]).toContain("script-src 'self';");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves hashed assets as immutable and compressed", async () => {
    const reply = await send("GET", "/assets/app-1a2b.js", { "accept-encoding": "gzip" });
    expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(reply.headers["content-type"]).toContain("text/javascript");
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(reply.body).toString()).toContain("console.log(1);");
  });

  it("returns 404 for a missing asset instead of the app shell", async () => {
    expect((await send("GET", "/assets/missing.js")).status).toBe(404);
  });

  it.each(["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc%2fpasswd"])(
    "blocks traversal through %s",
    async (attempt) => {
      const reply = await send("GET", attempt);
      expect(reply.body.toString()).not.toContain("root:");
      expect([200, 404]).toContain(reply.status);
      if (reply.status === 200) expect(reply.body.toString()).toContain("<title>Studio</title>");
    },
  );

  it("answers non-API paths with a hint when the web app is not built", async () => {
    http.closeStreams();
    http.server.closeAllConnections();
    await new Promise((resolve) => http.server.close(resolve));
    await start(false);
    const reply = await send("GET", "/");
    expect(reply.status).toBe(404);
    expect(reply.body.toString()).toContain("pnpm dev:web");
  });
});
