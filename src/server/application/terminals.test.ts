import type { DetectedPort } from "../../core/ports/detected-port.ts";
import { ok } from "../../core/result.ts";
import type { Route } from "../../core/routes/route.ts";
import type { SavedTerminal, TerminalHistory } from "../../core/terminals/terminal-history.ts";
import {
  type SpawnRequest,
  type TerminalFolders,
  type TerminalHistoryStore,
  TerminalManager,
  type TerminalManagerOptions,
  type TerminalProcess,
  type TerminalSpawner,
  type TerminalWorkspace,
} from "./terminals.ts";

type FakeProcess = TerminalProcess & {
  emit(text: string): void;
  exit(code: number | null): void;
  calls: string[];
  written: string[];
};

function fakeProcess(pid: number): FakeProcess {
  const dataListeners: ((text: string) => void)[] = [];
  const exitListeners: ((code: number | null) => void)[] = [];
  const calls: string[] = [];
  const written: string[] = [];
  return {
    pid,
    calls,
    written,
    write: (text) => written.push(text),
    interrupt: () => calls.push("interrupt"),
    terminate: () => calls.push("terminate"),
    kill: () => calls.push("kill"),
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    emit: (text) => {
      for (const listener of dataListeners) listener(text);
    },
    exit: (code) => {
      for (const listener of exitListeners) listener(code);
    },
  };
}

function fakeSpawner() {
  const spawned: { request: SpawnRequest; process: FakeProcess }[] = [];
  const spawner: TerminalSpawner = {
    mode: "pty",
    spawn: async (request) => {
      const process = fakeProcess(1000 + spawned.length);
      spawned.push({ request, process });
      return process;
    },
  };
  return { spawner, spawned };
}

const folders: TerminalFolders = {
  directory: (dir) => (dir.startsWith("/work") || dir.startsWith("/tmp") ? dir : null),
  contains: (parent, child) => child === parent || child.startsWith(`${parent}/`),
};

function route(name: string, port: number, path: string): Route {
  return {
    hostname: `${name}.localhost`,
    name,
    port,
    kind: "alias",
    pid: null,
    registeredAt: 1,
    url: `http://${name}.localhost:1355`,
    tunnels: [],
    project: { name: "shop", worktree: null, path },
  };
}

function fakeWorkspace() {
  const state: { routes: Route[]; detected: DetectedPort[] } = {
    routes: [route("web.shop", 3000, "/work/shop")],
    detected: [],
  };
  const listeners = new Set<() => void>();
  const aliases: string[] = [];
  const workspace: TerminalWorkspace = {
    openableFolders: async () => new Set(["/work/shop"]),
    snapshot: async () => state,
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    createAlias: async (name, port) => {
      aliases.push(`${name} ${port}`);
      return ok(undefined);
    },
    renameAlias: async (from, to) => {
      aliases.push(`rename ${from} ${to}`);
      return ok(undefined);
    },
  };
  const change = () => {
    for (const listener of listeners) listener();
  };
  return { workspace, state, listeners, aliases, change };
}

function setup(options: Partial<TerminalManagerOptions> = {}) {
  const spawner = fakeSpawner();
  const workspace = fakeWorkspace();
  const manager = new TerminalManager({
    spawner: spawner.spawner,
    workspace: workspace.workspace,
    folders,
    now: () => 1_000,
    graceMs: 100,
    ...options,
  });
  return { manager, ...spawner, ...workspace };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalManager", () => {
  it("starts a command in a folder Studio shows and lists it", async () => {
    const { manager, spawned } = setup();
    const created = await manager.create(
      { cwd: "/work/shop", command: "pnpm dev", cols: 100, rows: 30 },
      { trusted: false },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      id: "t1",
      title: "pnpm dev",
      cwd: "/work/shop",
      command: "pnpm dev",
      project: "shop",
      status: "running",
      pid: 1000,
      mode: "pty",
      cols: 100,
      rows: 30,
    });
    expect(spawned[0]?.request).toMatchObject({
      command: "pnpm dev",
      cwd: "/work/shop",
      cols: 100,
      rows: 30,
    });
    expect(spawned[0]?.request.env).toMatchObject({
      TERM: "xterm-256color",
      COLUMNS: "100",
      LINES: "30",
      PORTLESS_STUDIO_TERMINAL: "t1",
    });
    expect(manager.list().map((item) => item.id)).toEqual(["t1"]);
  });

  it("runs in a project's folder when given its name", async () => {
    const { manager, spawned } = setup();
    const created = await manager.create({ project: "shop" }, { trusted: false });
    expect(created.ok).toBe(true);
    expect(spawned[0]?.request).toMatchObject({ cwd: "/work/shop", command: null });
    if (created.ok) expect(created.value.title).toBe("shell");
  });

  it("refuses a folder Studio does not show unless a local program asks", async () => {
    const { manager, spawned } = setup();
    const fromPage = await manager.create({ cwd: "/tmp/other", command: "ls" }, { trusted: false });
    expect(fromPage).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "path_not_allowed" }),
    });
    expect(spawned).toHaveLength(0);

    const fromCli = await manager.create({ cwd: "/tmp/other", command: "ls" }, { trusted: true });
    expect(fromCli.ok).toBe(true);
    // Once a local program used the folder, the page may open terminals there too.
    const again = await manager.create({ cwd: "/tmp/other" }, { trusted: false });
    expect(again.ok).toBe(true);
  });

  it("refuses a folder that does not exist and an unknown project", async () => {
    const { manager } = setup();
    expect(await manager.create({ cwd: "/nope" }, { trusted: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "path_not_allowed" }),
    });
    expect(await manager.create({ cwd: "relative/dir" }, { trusted: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid_request" }),
    });
    expect(await manager.create({ project: "ghost" }, { trusted: false })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
  });

  it("keeps output with sequence numbers and streams new output to watchers", async () => {
    const { manager, spawned } = setup();
    const created = await manager.create({ cwd: "/work/shop", command: "x" }, { trusted: false });
    if (!created.ok) throw new Error("not created");
    const child = spawned[0]?.process;
    child?.emit("hello ");
    const seen: string[] = [];
    const watched = manager.subscribe("t1", 0, {
      onOutput: (chunk) => seen.push(`${chunk.seq}:${chunk.data}`),
      onStatus: () => {},
    });
    expect(watched.ok).toBe(true);
    child?.emit("world");
    expect(seen).toEqual(["0:hello ", "6:world"]);

    const read = manager.read("t1", 6);
    expect(read.ok && read.value).toMatchObject({ data: "world", from: 6, next: 11 });
    expect(manager.get("t1")?.nextSeq).toBe(11);
  });

  it("drops the oldest output past the buffer size", async () => {
    const { manager, spawned } = setup({ maxOutputChars: 8 });
    await manager.create({ cwd: "/work/shop", command: "x" }, { trusted: false });
    spawned[0]?.process.emit("0123456789");
    const read = manager.read("t1", 0);
    expect(read.ok && read.value).toMatchObject({ data: "23456789", from: 2, truncated: true });
  });

  it("writes input to the command and refuses it once the command ended", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "x" }, { trusted: false });
    const child = spawned[0]?.process;
    expect(manager.input("t1", "y\n")).toEqual({ ok: true, value: undefined });
    expect(child?.written).toEqual(["y\n"]);
    child?.exit(0);
    expect(manager.input("t1", "y\n")).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "terminal_not_running" }),
    });
    expect(manager.input("nope", "y")).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not_found" }),
    });
  });

  it("records the exit code and tells watchers", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "x" }, { trusted: false });
    const statuses: string[] = [];
    manager.subscribe("t1", 0, {
      onOutput: () => {},
      onStatus: (info) => statuses.push(`${info.status}:${info.exitCode}`),
    });
    let listChanges = 0;
    manager.watch(() => {
      listChanges += 1;
    });
    spawned[0]?.process.exit(3);
    expect(manager.get("t1")).toMatchObject({ status: "exited", exitCode: 3, endedAt: 1_000 });
    expect(statuses).toEqual(["exited:3"]);
    expect(listChanges).toBe(1);
    const read = manager.read("t1", 0);
    expect(read.ok && read.value.data).toContain("exited with code 3");
  });

  it("stops with Ctrl+C, then SIGTERM, then SIGKILL while the command keeps running", async () => {
    vi.useFakeTimers();
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "x" }, { trusted: false });
    const child = spawned[0]?.process;
    expect(manager.stop("t1").ok).toBe(true);
    expect(child?.calls).toEqual(["interrupt"]);
    vi.advanceTimersByTime(100);
    expect(child?.calls).toEqual(["interrupt", "terminate"]);
    vi.advanceTimersByTime(100);
    expect(child?.calls).toEqual(["interrupt", "terminate", "kill"]);
  });

  it("stops escalating once the command ends", async () => {
    vi.useFakeTimers();
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "x" }, { trusted: false });
    const child = spawned[0]?.process;
    manager.stop("t1");
    child?.exit(130);
    vi.advanceTimersByTime(1_000);
    expect(child?.calls).toEqual(["interrupt"]);
  });

  it("restarts the same command in the same terminal, keeping the output", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    spawned[0]?.process.emit("first\n");
    spawned[0]?.process.exit(0);
    const restarted = await manager.restart("t1");
    expect(restarted.ok && restarted.value).toMatchObject({ id: "t1", status: "running" });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.request.command).toBe("pnpm dev");
    // A late exit of the old process does not end the new one.
    spawned[0]?.process.exit(1);
    expect(manager.get("t1")?.status).toBe("running");
    const read = manager.read("t1", 0);
    expect(read.ok && read.value.data).toMatch(/first\n[\s\S]*restarted/);
  });

  it("closes a terminal and kills every command when Studio stops", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "a" }, { trusted: false });
    await manager.create({ cwd: "/work/shop", command: "b" }, { trusted: false });
    expect(manager.remove("t1").ok).toBe(true);
    expect(spawned[0]?.process.calls).toEqual(["kill"]);
    expect(manager.list().map((item) => item.id)).toEqual(["t2"]);
    manager.closeAll();
    expect(spawned[1]?.process.calls).toEqual(["terminate", "kill"]);
  });

  it("makes room for a new command by closing the terminal that ended longest ago", async () => {
    let clock = 1_000;
    const { manager, spawned } = setup({ maxTerminals: 3, now: () => clock });
    for (const command of ["a", "b", "c"]) {
      await manager.create({ cwd: "/work/shop", command }, { trusted: false });
    }
    clock = 3_000;
    spawned[1]?.process.exit(0);
    clock = 2_000;
    spawned[0]?.process.exit(0);

    const created = await manager.create({ cwd: "/work/shop", command: "d" }, { trusted: false });

    expect(created.ok).toBe(true);
    expect(manager.list().map((item) => item.id)).toEqual(["t2", "t3", "t4"]);
    expect(spawned[0]?.process.calls).toEqual([]);
  });

  it("closes only as many ended terminals as the new command needs", async () => {
    const { manager, spawned } = setup({ maxTerminals: 2 });
    await manager.create({ cwd: "/work/shop", command: "a" }, { trusted: false });
    await manager.create({ cwd: "/work/shop", command: "b" }, { trusted: false });
    spawned[0]?.process.exit(0);
    spawned[1]?.process.exit(0);

    await manager.create({ cwd: "/work/shop", command: "c" }, { trusted: false });

    expect(manager.list().map((item) => item.id)).toEqual(["t2", "t3"]);
    expect(manager.get("t2")?.status).toBe("exited");
  });

  it("refuses a new command when every terminal is still running", async () => {
    const { manager } = setup({ maxTerminals: 2 });
    await manager.create({ cwd: "/work/shop", command: "a" }, { trusted: false });
    await manager.create({ cwd: "/work/shop", command: "b" }, { trusted: false });

    const created = await manager.create({ cwd: "/work/shop", command: "c" }, { trusted: false });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("too_many_terminals");
    expect(created.error.message).toBe(
      "Studio already runs 2 terminals and all of them are still running. Stop one first.",
    );
    expect(manager.list()).toHaveLength(2);
  });

  it("names the first new port the command opens in its folder", async () => {
    const { manager, state, aliases, change, listeners } = setup();
    state.detected = [
      { port: 4000, pid: 1, processName: "node", cwd: "/work/old", suggestedName: "old" },
    ];
    await manager.create(
      { cwd: "/work/shop", command: "pnpm dev", name: true },
      { trusted: false },
    );
    expect(manager.get("t1")?.naming).toEqual({
      state: "waiting",
      requested: null,
      name: null,
      port: null,
    });
    expect(listeners.size).toBe(1);
    state.detected = [
      ...state.detected,
      {
        port: 5173,
        pid: 2,
        processName: "node",
        cwd: "/work/shop/apps/web",
        suggestedName: "web.shop",
      },
    ];
    change();
    await vi.waitFor(() => expect(manager.get("t1")?.naming?.state).toBe("named"));
    expect(aliases).toEqual(["web.shop 5173"]);
    expect(manager.get("t1")?.naming).toMatchObject({ name: "web.shop", port: 5173 });
    expect(listeners.size).toBe(0);
  });

  it("uses the name asked for, renaming a route auto mode gave first", async () => {
    const { manager, state, aliases, change } = setup();
    await manager.create(
      { cwd: "/work/shop", command: "pnpm dev", name: "pr-7.shop" },
      { trusted: false },
    );
    state.routes = [...state.routes, route("auto.shop", 5174, "/work/shop")];
    change();
    await vi.waitFor(() => expect(manager.get("t1")?.naming?.state).toBe("named"));
    expect(aliases).toEqual(["rename auto.shop pr-7.shop"]);
    expect(manager.get("t1")?.naming).toMatchObject({ name: "pr-7.shop", port: 5174 });
  });

  it("gives up naming when the command ends first", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "x", name: true }, { trusted: false });
    spawned[0]?.process.exit(1);
    expect(manager.get("t1")?.naming).toMatchObject({ state: "failed" });
  });

  it("renames a terminal, and an empty name gives back the default title", async () => {
    const { manager } = setup();
    let changes = 0;
    manager.watch(() => changes++);
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    const renamed = manager.rename("t1", "  api server  ");
    expect(renamed).toMatchObject({ ok: true, value: { title: "api server" } });
    expect(manager.get("t1")?.title).toBe("api server");
    expect(changes).toBe(2);
    expect(manager.rename("t1", "   ")).toMatchObject({ ok: true, value: { title: "pnpm dev" } });
    expect(manager.rename("t1", "x".repeat(80))).toMatchObject({
      ok: true,
      value: { title: "x".repeat(60) },
    });
    expect(manager.rename("t9", "a")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("titles a shell after the user's shell, and keeps the title across a restart", async () => {
    const spawner = fakeSpawner();
    const { manager } = setup({ spawner: { ...spawner.spawner, shellName: "zsh" } });
    await manager.create({ cwd: "/work/shop" }, { trusted: false });
    expect(manager.get("t1")?.title).toBe("zsh");
    manager.rename("t1", "scratch");
    spawner.spawned[0]?.process.exit(0);
    await manager.restart("t1");
    expect(manager.get("t1")?.title).toBe("scratch");
  });

  it("carries the worktree and branch of the folder's project, for grouping tabs", async () => {
    const { manager, state } = setup();
    state.routes = [
      {
        ...route("falcon.shop", 3100, "/work/shop-falcon"),
        project: {
          name: "shop",
          worktree: "falcon",
          branch: "feat/falcon",
          path: "/work/shop-falcon",
        },
      },
    ];
    const created = await manager.create({ cwd: "/work/shop-falcon/apps/web" }, { trusted: true });
    expect(created).toMatchObject({
      ok: true,
      value: { project: "shop", worktree: "falcon", branch: "feat/falcon" },
    });
    const outside = await manager.create({ cwd: "/tmp/scratch" }, { trusted: true });
    expect(outside).toMatchObject({
      ok: true,
      value: { project: null, worktree: null, branch: null },
    });
  });

  it("opens a folder picked by hand from the page only when it is an existing folder", async () => {
    const { manager, spawned } = setup({ homeDir: "/work" });
    const picked = await manager.create({ cwd: "/tmp/other" }, { trusted: false, picked: true });
    expect(picked).toMatchObject({ ok: true, value: { cwd: "/tmp/other" } });
    const home = await manager.create({ cwd: "~/notes" }, { trusted: false, picked: true });
    expect(home).toMatchObject({ ok: true, value: { cwd: "/work/notes" } });
    expect(await manager.create({ cwd: "/nope" }, { trusted: false, picked: true })).toMatchObject({
      ok: false,
      error: { code: "path_not_allowed", message: "/nope is not a folder on this machine." },
    });
    expect(await manager.create({ cwd: "notes" }, { trusted: false, picked: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(spawned).toHaveLength(2);
    // A picked folder does not open other page requests there.
    expect(await manager.create({ cwd: "/tmp/other" }, { trusted: false })).toMatchObject({
      ok: false,
      error: { code: "path_not_allowed" },
    });
  });

  it("lists the ports that processes started in the terminal listen on", async () => {
    const parents: Record<number, number[]> = { 2001: [1500, 1000, 1], 2002: [1, 0] };
    const { manager, state, change, listeners } = setup({
      processTree: { ancestors: async (pid) => parents[pid] ?? [] },
    });
    let changes = 0;
    const stopWatching = manager.watch(() => changes++);
    await manager.create({ cwd: "/work/shop" }, { trusted: false });
    expect(manager.get("t1")?.ports).toEqual([]);
    expect(listeners.size).toBe(1);
    state.detected = [
      { port: 5173, pid: 2001, processName: "node", cwd: "/work/shop", suggestedName: null },
      { port: 8080, pid: 2002, processName: "node", cwd: "/work/shop", suggestedName: null },
    ];
    state.routes = [{ ...route("web.shop", 3000, "/work/shop"), listenerPid: 2001 }];
    change();
    await vi.waitFor(() =>
      expect(manager.get("t1")?.ports).toEqual([
        { port: 3000, route: "web.shop", url: "http://web.shop.localhost:1355" },
        { port: 5173, route: null, url: null },
      ]),
    );
    expect(changes).toBeGreaterThan(1);
    stopWatching();
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });
});

function memoryHistory(initial: Partial<TerminalHistory> = {}) {
  const store = {
    saved: { running: [], recentCommands: {}, ...initial } as TerminalHistory,
    writes: 0,
    read: () => store.saved,
    write: (history: TerminalHistory) => {
      store.writes += 1;
      store.saved = history;
    },
  };
  return store satisfies TerminalHistoryStore;
}

const savedDev: SavedTerminal = {
  command: "pnpm dev",
  cwd: "/work/shop",
  title: "web",
  startedAt: 500,
  startedBy: "program",
  project: "shop",
  worktree: null,
  branch: "main",
};

describe("TerminalManager saved terminals", () => {
  it("writes the running terminals and who started them, and drops one once it ends", async () => {
    vi.useFakeTimers();
    const history = memoryHistory();
    const { manager, spawned } = setup({ history });
    await manager.create(
      { cwd: "/work/shop", command: "pnpm dev", title: "web" },
      { trusted: true },
    );
    await manager.create({ cwd: "/work/shop" }, { trusted: false });
    vi.runOnlyPendingTimers();
    expect(history.saved.running).toEqual([
      { ...savedDev, startedAt: 1_000, branch: null },
      {
        command: "",
        cwd: "/work/shop",
        title: "shell",
        startedAt: 1_000,
        startedBy: "person",
        project: "shop",
        worktree: null,
        branch: null,
      },
    ]);
    expect(manager.list().map((info) => info.startedBy)).toEqual(["program", "person"]);
    spawned[0]?.process.exit(0);
    vi.runOnlyPendingTimers();
    expect(history.saved.running.map((item) => item.command)).toEqual([""]);
  });

  it("remembers the last commands per folder, newest first", async () => {
    vi.useFakeTimers();
    const history = memoryHistory({ recentCommands: { "/work/shop": ["pnpm test"] } });
    const { manager } = setup({ history });
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    await manager.create({ cwd: "/work/shop", command: "pnpm test" }, { trusted: false });
    await manager.create({ cwd: "/work/shop" }, { trusted: false });
    expect(manager.recentCommands()).toEqual({ "/work/shop": ["pnpm test", "pnpm dev"] });
    vi.runOnlyPendingTimers();
    expect(history.saved.recentCommands).toEqual({ "/work/shop": ["pnpm test", "pnpm dev"] });
  });

  it("keeps the running terminals in the file when Studio stops, even those ending with it", async () => {
    const history = memoryHistory();
    let now = 1_000;
    const { manager, spawned } = setup({ history, now: () => now });
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: true });
    await manager.create({ cwd: "/work/shop", command: "pnpm api" }, { trusted: true });
    await manager.create({ cwd: "/work/shop", command: "pnpm lint" }, { trusted: true });
    manager.stop("t3");
    spawned[2]?.process.exit(130);
    // A service manager stops the commands together with Studio.
    now = 1_500;
    spawned[1]?.process.exit(143);
    manager.closeAll();
    expect(history.saved.running.map((item) => item.command)).toEqual(["pnpm dev", "pnpm api"]);
    spawned[0]?.process.exit(143);
    expect(history.saved.running.map((item) => item.command)).toEqual(["pnpm dev", "pnpm api"]);
  });

  it("lists the terminals that were running as stopped by a restart, ready to run again", async () => {
    const history = memoryHistory({ running: [savedDev] });
    const { manager, spawned } = setup({ history });
    await manager.restore("ask");
    expect(spawned).toHaveLength(0);
    const [restored] = manager.list();
    expect(restored).toMatchObject({
      id: "t1",
      title: "web",
      command: "pnpm dev",
      cwd: "/work/shop",
      status: "exited",
      exitCode: null,
      stoppedByRestart: true,
      startedBy: "program",
      branch: "main",
    });
    const again = await manager.restart("t1");
    expect(again.ok && again.value).toMatchObject({ status: "running", stoppedByRestart: false });
    expect(spawned[0]?.request).toMatchObject({ command: "pnpm dev", cwd: "/work/shop" });
  });

  it("runs saved commands again on start with always, but never a plain shell", async () => {
    const shell = { ...savedDev, command: "", title: "zsh" };
    const history = memoryHistory({ running: [savedDev, shell] });
    const { manager, spawned } = setup({ history });
    await manager.restore("always");
    expect(spawned.map((item) => item.request.command)).toEqual(["pnpm dev"]);
    expect(manager.list().map((info) => [info.status, info.stoppedByRestart])).toEqual([
      ["running", false],
      ["exited", true],
    ]);
  });

  it("forgets them with never, and skips folders that are gone", async () => {
    const gone = { ...savedDev, cwd: "/gone/app" };
    const history = memoryHistory({ running: [gone] });
    const first = setup({ history });
    await first.manager.restore("ask");
    expect(first.manager.list()).toEqual([]);

    const again = memoryHistory({ running: [savedDev] });
    const second = setup({ history: again });
    await second.manager.restore("never");
    expect(second.manager.list()).toEqual([]);
    expect(again.saved.running).toEqual([]);
  });
});

describe.each(["pty", "pipes"] as const)("stop/restart safety with %s transport", (mode) => {
  it("does not spawn two replacement processes for simultaneous restarts", async () => {
    const base = fakeSpawner();
    const { manager } = setup({ spawner: { ...base.spawner, mode } });
    const { spawned } = base;
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    const first = manager.restart("t1");
    const second = manager.restart("t1");
    spawned[0]?.process.exit(130);
    await Promise.all([first, second]);
    expect(spawned).toHaveLength(2);
    manager.closeAll();
  });
  it("does not spawn a replacement after the terminal is removed during restart", async () => {
    const base = fakeSpawner();
    const { manager } = setup({ spawner: { ...base.spawner, mode } });
    const { spawned } = base;
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    const pending = manager.restart("t1");
    manager.remove("t1");
    spawned[0]?.process.exit(130);
    await pending;
    expect(spawned).toHaveLength(1);
    manager.closeAll();
  });
  it("cancels a pending restart when Stop is requested", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    const pending = manager.restart("t1");
    manager.stop("t1");
    spawned[0]?.process.exit(130);
    expect((await pending).ok).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(manager.get("t1")?.status).toBe("exited");
    manager.closeAll();
  });

  it("kills a replacement that finishes spawning after its terminal was closed", async () => {
    const base = fakeSpawner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { manager } = setup({
      spawner: {
        ...base.spawner,
        mode,
        spawn: async (request) => {
          calls += 1;
          if (calls > 1) await gate;
          return base.spawner.spawn(request);
        },
      },
    });
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    const pending = manager.restart("t1");
    base.spawned[0]?.process.exit(130);
    await vi.waitFor(() => expect(calls).toBe(2));
    manager.remove("t1");
    release();
    expect((await pending).ok).toBe(false);
    expect(base.spawned[1]?.process.calls).toContain("kill");
    expect(manager.list()).toEqual([]);
    manager.closeAll();
  });

  it("does not restart while Studio is shutting down", async () => {
    const { manager, spawned } = setup();
    await manager.create({ cwd: "/work/shop", command: "pnpm dev" }, { trusted: false });
    const pending = manager.restart("t1");
    manager.closeAll();
    spawned[0]?.process.exit(130);
    expect((await pending).ok).toBe(false);
    expect((await manager.restart("t1")).ok).toBe(false);
    expect(spawned).toHaveLength(1);
  });
});
