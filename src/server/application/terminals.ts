import type {
  CreateTerminalRequest,
  TerminalOutputChunk,
  TerminalOutputResponse,
} from "../../core/api/contract.ts";
import type { RestoreTerminals } from "../../core/config/studio-config.ts";
import type { DetectedPort } from "../../core/ports/detected-port.ts";
import { err, ok, type Result } from "../../core/result.ts";
import type { ItemProject, Route } from "../../core/routes/route.ts";
import { OutputBuffer } from "../../core/terminals/output-buffer.ts";
import type {
  TerminalInfo,
  TerminalMode,
  TerminalNaming,
  TerminalPort,
} from "../../core/terminals/terminal.ts";
import {
  rememberCommand,
  type SavedTerminal,
  type TerminalHistory,
  type TerminalStarter,
} from "../../core/terminals/terminal-history.ts";
import { type AppError, appError } from "./app-error.ts";

/** A running command, as the spawner started it. */
export interface TerminalProcess {
  readonly pid: number | null;
  write(text: string): void;
  /** Ctrl+C: through the pseudo-terminal, or SIGINT to the process group with pipes. */
  interrupt(): void;
  /** SIGTERM to the process group; the whole process tree on Windows. */
  terminate(): void;
  /** SIGKILL to the process group; the whole process tree on Windows. */
  kill(): void;
  onData(listener: (text: string) => void): void;
  /** Called once, with the exit code, or null when a signal ended it. */
  onExit(listener: (exitCode: number | null) => void): void;
}

export type SpawnRequest = {
  /** null starts the user's interactive shell. */
  command: string | null;
  cwd: string;
  cols: number;
  rows: number;
  /** Added to Studio's own environment. */
  env: Record<string, string>;
};

/** Starts commands; `infrastructure/terminal` has the pseudo-terminal and pipe versions. */
export interface TerminalSpawner {
  readonly mode: TerminalMode;
  /** The interactive shell's short name, e.g. `zsh`: a shell terminal's default title. */
  readonly shellName?: string;
  spawn(request: SpawnRequest): Promise<TerminalProcess>;
}

/** The file system questions the manager asks about folders. */
export interface TerminalFolders {
  /** The folder as an absolute, normalized path when it is an existing directory, else null. */
  directory(path: string): string | null;
  /** Whether `child` is `parent` or inside it. */
  contains(parent: string, child: string): boolean;
}

/** What the manager needs from the rest of Studio: what it shows, and naming ports. */
export interface TerminalWorkspace {
  /** Project folders of the routes and detected ports Studio shows or showed. */
  openableFolders(): Promise<Set<string>>;
  snapshot(): Promise<{ routes: Route[]; detected: DetectedPort[] }>;
  /** Calls `onChange` after routes or detected ports change; Studio scans while subscribed. */
  watch(onChange: () => void): () => void;
  createAlias(name: string, port: number): Promise<Result<void, AppError>>;
  renameAlias(from: string, to: string): Promise<Result<void, AppError>>;
}

/** Parent processes, to tell which listening process a terminal started. */
export interface ProcessTree {
  /** The pid's parent, its parent and so on; empty when the system does not say. */
  ancestors(pid: number): Promise<number[]>;
}

/**
 * Keeps `terminals.json`: the terminals running when Studio stopped and the recent commands per
 * folder. Synchronous, so the last write lands before Studio exits.
 */
export interface TerminalHistoryStore {
  read(): TerminalHistory;
  write(history: TerminalHistory): void;
}

export type TerminalWatcher = {
  onOutput(chunk: TerminalOutputChunk): void;
  onStatus(info: TerminalInfo): void;
};

export type TerminalManagerOptions = {
  spawner: TerminalSpawner;
  workspace: TerminalWorkspace;
  folders: TerminalFolders;
  now?: () => number;
  /** Characters of output kept per terminal; older output is dropped. */
  maxOutputChars?: number;
  /** Wait between Ctrl+C, SIGTERM and SIGKILL. */
  graceMs?: number;
  maxTerminals?: number;
  /** How long `run` waits for the command to open a port before giving up naming it. */
  namingTimeoutMs?: number;
  /** Links listening processes to terminals; without it terminals list no ports. */
  processTree?: ProcessTree;
  /** What `~` means in a folder picked by hand. */
  homeDir?: string;
  /** Where the running terminals and recent commands are kept between runs; none without it. */
  history?: TerminalHistoryStore;
  /** Wait that gathers several changes into one write of the history. */
  persistDelayMs?: number;
};

/**
 * Who asks: `trusted` is a local program (CLI, MCP server), not a browser page. `picked` is the
 * page's folder picker, where the person typed the folder: any existing folder is allowed.
 */
export type RequestOrigin = { trusted: boolean; picked?: boolean };

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_MAX_TERMINALS = 32;
const DEFAULT_NAMING_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_TITLE_CHARS = 60;
const DEFAULT_PERSIST_DELAY_MS = 300;
/**
 * A command that ended this shortly before Studio stopped counts as running then: a service
 * manager stops Studio's commands together with Studio, and their exits can arrive first.
 */
const RECENT_EXIT_MS = 2_000;
const RESTART_NOTE = "\r\n[Studio] Stopped by a Studio restart. Run it again to start it.\r\n";

type Entry = {
  info: TerminalInfo;
  /** The command, or the shell's name; the title an empty rename gives back. */
  defaultTitle: string;
  request: SpawnRequest;
  buffer: OutputBuffer;
  process: TerminalProcess | null;
  stopTimers: NodeJS.Timeout[];
  watchers: Set<TerminalWatcher>;
  /** Ports in use when naming started; a new port is one not in here. */
  baseline: Set<number> | null;
  namingTimer: NodeJS.Timeout | undefined;
  /** Someone asked it to stop, so its end is not caused by Studio stopping. */
  stoppedOnPurpose: boolean;
  restartPromise: Promise<Result<TerminalInfo, AppError>> | null;
  restartGeneration: number;
};

type NewEntry = {
  id: string;
  command: string | null;
  cwd: string;
  title: string | undefined;
  cols: number;
  rows: number;
  naming: TerminalNaming | null;
  project: Pick<ItemProject, "name" | "worktree" | "branch"> | null;
  startedBy: TerminalStarter;
  startedAt: number;
};

/**
 * The terminals Studio runs. Each keeps its last `maxOutputChars` of output, numbered so a client
 * can resume where it stopped. From a page, commands run only in folders Studio shows; a local
 * program may pick any folder, which the page may then use too. See docs/terminals.md.
 */
export class TerminalManager {
  readonly #spawner: TerminalSpawner;
  readonly #workspace: TerminalWorkspace;
  readonly #folders: TerminalFolders;
  readonly #now: () => number;
  readonly #maxOutput: number;
  readonly #graceMs: number;
  readonly #maxTerminals: number;
  readonly #namingTimeoutMs: number;
  readonly #processTree: ProcessTree | undefined;
  readonly #homeDir: string | undefined;
  readonly #history: TerminalHistoryStore | undefined;
  readonly #persistDelayMs: number;
  #recent: Record<string, string[]> | null = null;
  #persistTimer: NodeJS.Timeout | undefined;
  #closing = false;
  readonly #entries = new Map<string, Entry>();
  readonly #watchers = new Set<() => void>();
  /** Folders a local program ran a terminal in. */
  readonly #trustedFolders = new Set<string>();
  #nextId = 1;
  #stopWorkspaceWatch: (() => void) | undefined;
  #naming = false;
  #refreshingPorts = false;
  #portsAgain = false;

  constructor(options: TerminalManagerOptions) {
    this.#spawner = options.spawner;
    this.#workspace = options.workspace;
    this.#folders = options.folders;
    this.#now = options.now ?? Date.now;
    this.#maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.#maxTerminals = options.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    this.#namingTimeoutMs = options.namingTimeoutMs ?? DEFAULT_NAMING_TIMEOUT_MS;
    this.#processTree = options.processTree;
    this.#homeDir = options.homeDir;
    this.#history = options.history;
    this.#persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
  }

  get mode(): TerminalMode {
    return this.#spawner.mode;
  }

  list(): TerminalInfo[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.info }));
  }

  get(id: string): TerminalInfo | null {
    const entry = this.#entries.get(id);
    return entry ? { ...entry.info } : null;
  }

  /** Calls `onChange` when a terminal starts, ends, is named or closes. */
  watch(onChange: () => void): () => void {
    this.#watchers.add(onChange);
    this.#updateWorkspaceWatch();
    return () => {
      this.#watchers.delete(onChange);
      this.#updateWorkspaceWatch();
    };
  }

  /** Gives the terminal a name of its own; an empty one gives back the default title. */
  rename(id: string, title: string): Result<TerminalInfo, AppError> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    const wanted = title.trim().slice(0, MAX_TITLE_CHARS);
    entry.info = { ...entry.info, title: wanted || entry.defaultTitle };
    this.#publishStatus(entry);
    this.#schedulePersist();
    return ok({ ...entry.info });
  }

  async create(
    request: CreateTerminalRequest,
    origin: RequestOrigin,
  ): Promise<Result<TerminalInfo, AppError>> {
    this.#closeEndedForRoom(1);
    if (this.#entries.size >= this.#maxTerminals) {
      return err(
        appError(
          "too_many_terminals",
          `Studio already runs ${this.#maxTerminals} terminals and all of them are still running. Stop one first.`,
        ),
      );
    }
    const command = readCommand(request.command);
    if (!command.ok) return command;
    const cwd = await this.#resolveFolder(request, origin);
    if (!cwd.ok) return cwd;
    if (origin.trusted) this.#trustedFolders.add(cwd.value);

    const naming = readNaming(request.name);
    const project = await this.#projectOf(cwd.value);
    const entry = this.#newEntry({
      id: `t${this.#nextId++}`,
      command: command.value,
      cwd: cwd.value,
      title: request.title,
      cols: readSize(request.cols, DEFAULT_COLS),
      rows: readSize(request.rows, DEFAULT_ROWS),
      naming,
      project,
      startedBy: origin.trusted ? "program" : "person",
      startedAt: this.#now(),
    });
    if (naming) entry.baseline = await this.#portsInUse();
    const started = await this.#spawn(entry);
    if (!started.ok) return started;
    this.#entries.set(entry.info.id, entry);
    if (command.value) {
      this.#recent = rememberCommand(this.#recentCommands(), cwd.value, command.value);
    }
    if (naming) this.#startNaming(entry);
    else this.#updateWorkspaceWatch();
    this.#changed();
    this.#schedulePersist();
    if (this.#watchers.size > 0) void this.#refreshPorts();
    return ok({ ...entry.info });
  }

  /** The last commands run in each folder, newest first. */
  recentCommands(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(this.#recentCommands()).map(([folder, list]) => [folder, [...list]]),
    );
  }

  /**
   * Brings back the terminals that were running when Studio last stopped: listed as stopped by a
   * restart (`ask`), started again unless they are a plain shell (`always`), or forgotten
   * (`never`). Folders that no longer exist are skipped. Call it once, on start.
   */
  async restore(mode: RestoreTerminals): Promise<void> {
    if (this.#closing) return;
    const saved = this.#history?.read().running ?? [];
    if (mode === "never" || saved.length === 0) {
      if (saved.length > 0) this.#persistNow();
      return;
    }
    const restored: Entry[] = [];
    for (const item of saved) {
      if (this.#entries.size >= this.#maxTerminals) break;
      const cwd = this.#folders.directory(item.cwd);
      if (cwd === null) continue;
      if (item.startedBy === "program") this.#trustedFolders.add(cwd);
      const entry = this.#newEntry({
        id: `t${this.#nextId++}`,
        command: item.command || null,
        cwd,
        title: item.title,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        naming: null,
        project: { name: item.project ?? "", worktree: item.worktree, branch: item.branch },
        startedBy: item.startedBy,
        startedAt: item.startedAt,
      });
      if (item.project === null) {
        entry.info = { ...entry.info, project: null, worktree: null, branch: null };
      }
      entry.info = { ...entry.info, status: "exited", stoppedByRestart: true };
      this.#append(entry, RESTART_NOTE);
      this.#entries.set(entry.info.id, entry);
      restored.push(entry);
    }
    this.#changed();
    this.#persistNow();
    if (mode !== "always") return;
    for (const entry of restored) {
      if (this.#closing) return;
      if (entry.info.command !== "") await this.restart(entry.info.id);
    }
  }

  input(id: string, text: string): Result<void, AppError> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    if (!entry.process || entry.info.status !== "running") return notRunning(entry);
    entry.process.write(text);
    return ok(undefined);
  }

  /** Ctrl+C now; SIGTERM, then SIGKILL, each after `graceMs` while the command still runs. */
  stop(id: string): Result<TerminalInfo, AppError> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    entry.restartGeneration += 1;
    if (!entry.process || entry.info.status !== "running") return ok({ ...entry.info });
    entry.stoppedOnPurpose = true;
    this.#escalate(entry, entry.process);
    return ok({ ...entry.info });
  }

  /** Runs the same command again; stops the current one first and waits for it to end. */
  restart(id: string): Promise<Result<TerminalInfo, AppError>> {
    const entry = this.#entries.get(id);
    if (!entry) return Promise.resolve(notFound(id));
    if (this.#closing)
      return Promise.resolve(err(appError("command_failed", "Studio is stopping.")));
    if (entry.restartPromise) return entry.restartPromise;
    let resolve!: (result: Result<TerminalInfo, AppError>) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<Result<TerminalInfo, AppError>>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    // Register before interrupting: an exit callback can synchronously request another restart.
    entry.restartPromise = pending;
    void this.#restartEntry(entry, entry.restartGeneration).then(
      (result) => {
        entry.restartPromise = null;
        resolve(result);
      },
      (error) => {
        entry.restartPromise = null;
        reject(error);
      },
    );
    return pending;
  }

  async #restartEntry(entry: Entry, generation: number): Promise<Result<TerminalInfo, AppError>> {
    const stillWanted = () =>
      !this.#closing &&
      this.#entries.get(entry.info.id) === entry &&
      entry.restartGeneration === generation;
    const cancelled = () => err(appError("terminal_not_running", "The restart was cancelled."));
    const current = entry.process;
    if (current && entry.info.status === "running") {
      const ended = new Promise<void>((resolve) => current.onExit(() => resolve()));
      entry.stoppedOnPurpose = true;
      this.#escalate(entry, current);
      await ended;
    }
    if (!stillWanted()) return cancelled();
    this.#append(entry, `\r\n[Studio] restarted: ${entry.info.command || "shell"}\r\n`);
    if (entry.info.project === null) {
      const project = await this.#projectOf(entry.info.cwd);
      if (project) {
        entry.info = {
          ...entry.info,
          project: project.name,
          worktree: project.worktree ?? null,
          branch: project.branch ?? null,
        };
      }
    }
    if (!stillWanted()) return cancelled();
    const started = await this.#spawn(entry, stillWanted);
    if (!started.ok) return started;
    if (!stillWanted()) {
      entry.process?.kill();
      entry.process = null;
      return cancelled();
    }
    entry.stoppedOnPurpose = false;
    entry.info = {
      ...entry.info,
      status: "running",
      exitCode: null,
      endedAt: null,
      stoppedByRestart: false,
    };
    entry.info.startedAt = this.#now();
    this.#publishStatus(entry);
    this.#schedulePersist();
    this.#updateWorkspaceWatch();
    if (this.#watchers.size > 0) void this.#refreshPorts();
    return ok({ ...entry.info });
  }

  /**
   * Closes terminals whose command already ended until there is room for `wanted` more, oldest end
   * first. A terminal nobody is running holds a slot and 2 MB of output only until that slot is
   * needed, so starting a command does not ask the person to tidy up first.
   */
  #closeEndedForRoom(wanted: number): void {
    let room = this.#maxTerminals - this.#entries.size;
    if (room >= wanted) return;
    const ended = [...this.#entries.values()]
      .filter((entry) => entry.info.status === "exited")
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
    for (const entry of ended) {
      if (room >= wanted) return;
      this.remove(entry.info.id);
      room += 1;
    }
  }

  /** Closes the terminal; its command, if still running, is killed. */
  remove(id: string): Result<void, AppError> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    this.#entries.delete(id);
    this.#clearTimers(entry);
    if (entry.process && entry.info.status === "running") entry.process.kill();
    entry.process = null;
    entry.watchers.clear();
    this.#updateWorkspaceWatch();
    this.#changed();
    this.#schedulePersist();
    return ok(undefined);
  }

  read(id: string, from: number, maxChars?: number): Result<TerminalOutputResponse, AppError> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    const slice = entry.buffer.read(from, maxChars);
    return ok({ terminal: { ...entry.info }, ...slice });
  }

  /** Sends the kept output from `from` to `watcher` right away, then everything new. */
  subscribe(id: string, from: number, watcher: TerminalWatcher): Result<() => void, AppError> {
    const entry = this.#entries.get(id);
    if (!entry) return notFound(id);
    const backlog = entry.buffer.read(from);
    if (backlog.data !== "") watcher.onOutput({ seq: backlog.from, data: backlog.data });
    entry.watchers.add(watcher);
    return ok(() => entry.watchers.delete(watcher));
  }

  /**
   * Studio is stopping: the terminals still running are written down for the next start, then
   * every command gets SIGTERM and SIGKILL right away.
   */
  closeAll(): void {
    if (!this.#closing) {
      this.#persistNow(true);
      this.#closing = true;
      clearTimeout(this.#persistTimer);
    }
    for (const entry of this.#entries.values()) {
      this.#clearTimers(entry);
      if (entry.process && entry.info.status === "running") {
        entry.process.terminate();
        entry.process.kill();
      }
    }
    this.#stopWorkspaceWatch?.();
    this.#stopWorkspaceWatch = undefined;
  }

  async #spawn(entry: Entry, stillWanted?: () => boolean): Promise<Result<void, AppError>> {
    let child: TerminalProcess;
    try {
      child = await this.#spawner.spawn(entry.request);
    } catch (error) {
      return err(appError("command_failed", `Could not start it: ${(error as Error).message}`));
    }
    if (stillWanted && !stillWanted()) {
      child.kill();
      return err(appError("terminal_not_running", "The restart was cancelled."));
    }
    entry.process = child;
    entry.info.pid = child.pid;
    entry.info.mode = this.#spawner.mode;
    child.onData((text) => {
      if (entry.process === child) this.#append(entry, text);
    });
    child.onExit((exitCode) => {
      if (entry.process !== child) return;
      this.#clearTimers(entry);
      entry.process = null;
      this.#append(
        entry,
        `\r\n[Studio] ${exitCode === null ? "stopped by a signal" : `exited with code ${exitCode}`}\r\n`,
      );
      entry.info = { ...entry.info, status: "exited", exitCode, endedAt: this.#now() };
      if (entry.info.naming?.state === "waiting") {
        this.#setNaming(entry, {
          state: "failed",
          message: "The command ended before it opened a port.",
        });
      }
      entry.info.ports = [];
      this.#publishStatus(entry);
      this.#schedulePersist();
      this.#updateWorkspaceWatch();
    });
    return ok(undefined);
  }

  #newEntry(fields: NewEntry): Entry {
    const defaultTitle = (fields.command || this.#spawner.shellName || "shell").slice(
      0,
      MAX_TITLE_CHARS,
    );
    const title = fields.title?.trim().slice(0, MAX_TITLE_CHARS) || defaultTitle;
    const { id, cols, rows } = fields;
    return {
      defaultTitle,
      info: {
        id,
        title,
        cwd: fields.cwd,
        command: fields.command ?? "",
        project: fields.project?.name ?? null,
        worktree: fields.project?.worktree ?? null,
        branch: fields.project?.branch ?? null,
        ports: [],
        status: "running",
        exitCode: null,
        startedAt: fields.startedAt,
        endedAt: null,
        pid: null,
        mode: this.#spawner.mode,
        cols,
        rows,
        nextSeq: 0,
        naming: fields.naming,
        startedBy: fields.startedBy,
        stoppedByRestart: false,
      },
      request: {
        command: fields.command,
        cwd: fields.cwd,
        cols,
        rows,
        env: {
          TERM: "xterm-256color",
          COLUMNS: String(cols),
          LINES: String(rows),
          PORTLESS_STUDIO_TERMINAL: id,
        },
      },
      buffer: new OutputBuffer(this.#maxOutput),
      process: null,
      stopTimers: [],
      watchers: new Set(),
      baseline: null,
      namingTimer: undefined,
      stoppedOnPurpose: false,
      restartPromise: null,
      restartGeneration: 0,
    };
  }

  #recentCommands(): Record<string, string[]> {
    this.#recent ??= this.#history?.read().recentCommands ?? {};
    return this.#recent;
  }

  #schedulePersist(): void {
    if (!this.#history || this.#closing || this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      this.#persistNow();
    }, this.#persistDelayMs);
    this.#persistTimer.unref?.();
  }

  /**
   * Writes the terminals that run and the recent commands. When Studio stops, commands that just
   * ended without anyone asking count as running too.
   */
  #persistNow(stopping = false): void {
    const history = this.#history;
    if (!history || this.#closing) return;
    clearTimeout(this.#persistTimer);
    this.#persistTimer = undefined;
    const now = this.#now();
    const running: SavedTerminal[] = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.info.status === "running" ||
          entry.info.stoppedByRestart === true ||
          (stopping &&
            !entry.stoppedOnPurpose &&
            entry.info.endedAt !== null &&
            now - entry.info.endedAt <= RECENT_EXIT_MS),
      )
      .map(({ info }) => ({
        command: info.command,
        cwd: info.cwd,
        title: info.title,
        startedAt: info.startedAt,
        startedBy: info.startedBy ?? "person",
        project: info.project,
        worktree: info.worktree,
        branch: info.branch,
      }));
    try {
      history.write({ running, recentCommands: this.#recentCommands() });
    } catch {
      // A full disk or a read-only config folder: terminals keep working, they just are not kept.
    }
  }

  #escalate(entry: Entry, child: TerminalProcess): void {
    this.#clearTimers(entry);
    child.interrupt();
    const steps = [() => child.terminate(), () => child.kill()];
    steps.forEach((step, index) => {
      const timer = setTimeout(
        () => {
          if (entry.process === child) step();
        },
        this.#graceMs * (index + 1),
      );
      entry.stopTimers.push(timer);
    });
  }

  #append(entry: Entry, text: string): void {
    const seq = entry.buffer.end;
    entry.info.nextSeq = entry.buffer.append(text);
    for (const watcher of entry.watchers) watcher.onOutput({ seq, data: text });
  }

  #publishStatus(entry: Entry): void {
    const info = { ...entry.info };
    for (const watcher of entry.watchers) watcher.onStatus(info);
    this.#changed();
  }

  #clearTimers(entry: Entry): void {
    for (const timer of entry.stopTimers) clearTimeout(timer);
    entry.stopTimers = [];
  }

  #changed(): void {
    for (const watcher of this.#watchers) watcher();
  }

  async #resolveFolder(
    request: CreateTerminalRequest,
    origin: RequestOrigin,
  ): Promise<Result<string, AppError>> {
    if (origin.picked) return this.#pickedFolder(request.cwd);
    if (typeof request.project === "string" && request.project !== "" && !request.cwd) {
      const folder = await this.#projectFolder(request.project);
      if (folder === null) {
        return err(appError("not_found", `Studio shows no project named "${request.project}".`));
      }
      return ok(folder);
    }
    if (typeof request.cwd !== "string" || request.cwd === "") {
      return err(appError("invalid_request", "Give the folder to run in (cwd) or a project."));
    }
    if (!isAbsolute(request.cwd)) {
      return err(appError("invalid_request", "The folder must be an absolute path."));
    }
    const folder = this.#folders.directory(request.cwd);
    if (folder === null) {
      return err(appError("path_not_allowed", `${request.cwd} is not a folder on this machine.`));
    }
    if (origin.trusted || this.#trustedFolders.has(folder)) return ok(folder);
    const allowed = await this.#workspace.openableFolders();
    if (allowed.has(folder)) return ok(folder);
    return err(
      appError(
        "path_not_allowed",
        "Terminals run only in project folders Studio shows. Start it from the CLI to use another folder.",
      ),
    );
  }

  /** A folder typed in the page's picker: any existing folder, with `~` as the home folder. */
  #pickedFolder(typed: unknown): Result<string, AppError> {
    if (typeof typed !== "string" || typed.trim() === "") {
      return err(appError("invalid_request", "Give the folder to open."));
    }
    let wanted = typed.trim();
    if (this.#homeDir && (wanted === "~" || /^~[\\/]/.test(wanted))) {
      wanted = `${this.#homeDir}${wanted.slice(1)}`;
    }
    if (!isAbsolute(wanted)) {
      return err(
        appError("invalid_request", "The folder must be an absolute path or start with ~."),
      );
    }
    const folder = this.#folders.directory(wanted);
    if (folder === null) {
      return err(appError("path_not_allowed", `${wanted} is not a folder on this machine.`));
    }
    return ok(folder);
  }

  async #projectFolder(name: string): Promise<string | null> {
    const { routes, detected } = await this.#workspace.snapshot();
    for (const item of [...routes, ...detected]) {
      const path = item.project?.path;
      if (item.project?.name === name && path) return this.#folders.directory(path);
    }
    return null;
  }

  /** The project whose folder holds `cwd`, the innermost one when several do. */
  async #projectOf(cwd: string): Promise<ItemProject | null> {
    const { routes, detected } = await this.#workspace.snapshot();
    let best: ItemProject | null = null;
    for (const item of [...routes, ...detected]) {
      const path = item.project?.path;
      if (!item.project || !path || !this.#folders.contains(path, cwd)) continue;
      if (!best?.path || path.length > best.path.length) best = item.project;
    }
    return best;
  }

  /**
   * Links every listening process to the running terminal it descends from, and publishes the
   * terminals whose ports changed. Calls that arrive while one runs make it run once more.
   */
  async #refreshPorts(): Promise<void> {
    const tree = this.#processTree;
    if (!tree) return;
    if (this.#refreshingPorts) {
      this.#portsAgain = true;
      return;
    }
    this.#refreshingPorts = true;
    try {
      do {
        this.#portsAgain = false;
        await this.#linkPorts(tree);
      } while (this.#portsAgain);
    } finally {
      this.#refreshingPorts = false;
    }
  }

  async #linkPorts(tree: ProcessTree): Promise<void> {
    const running = [...this.#entries.values()].filter(
      (entry) => entry.info.status === "running" && entry.info.pid !== null,
    );
    if (running.length === 0) return;
    const { routes, detected } = await this.#workspace.snapshot();
    const listeners = new Map<number, TerminalPort>();
    for (const item of detected) {
      if (item.pid !== null) listeners.set(item.port, { port: item.port, route: null, url: null });
    }
    const pids = new Map<number, number>();
    for (const item of detected) if (item.pid !== null) pids.set(item.port, item.pid);
    for (const item of routes) {
      if (item.listenerPid === undefined) continue;
      pids.set(item.port, item.listenerPid);
      listeners.set(item.port, { port: item.port, route: item.name, url: item.url });
    }
    const ancestry = new Map<number, number[]>();
    for (const pid of new Set(pids.values())) {
      ancestry.set(pid, await tree.ancestors(pid).catch(() => []));
    }
    for (const entry of running) {
      const pid = entry.info.pid;
      const ports = [...pids]
        .filter(([, listener]) => listener === pid || ancestry.get(listener)?.includes(pid ?? -1))
        .map(([port]) => listeners.get(port))
        .filter((port): port is TerminalPort => port !== undefined)
        .sort((a, b) => a.port - b.port);
      if (JSON.stringify(ports) === JSON.stringify(entry.info.ports)) continue;
      entry.info = { ...entry.info, ports };
      this.#publishStatus(entry);
    }
  }

  async #portsInUse(): Promise<Set<number>> {
    const { routes, detected } = await this.#workspace.snapshot();
    return new Set([...routes.map((route) => route.port), ...detected.map((port) => port.port)]);
  }

  #startNaming(entry: Entry): void {
    entry.namingTimer = setTimeout(() => {
      if (entry.info.naming?.state !== "waiting") return;
      this.#setNaming(entry, {
        state: "failed",
        message: `No new port opened in ${entry.info.cwd} within ${Math.round(this.#namingTimeoutMs / 1000)} s.`,
      });
      this.#publishStatus(entry);
    }, this.#namingTimeoutMs);
    entry.namingTimer.unref?.();
    this.#updateWorkspaceWatch();
  }

  #waitingEntries(): Entry[] {
    return [...this.#entries.values()].filter((entry) => entry.info.naming?.state === "waiting");
  }

  /**
   * Watches the workspace, which keeps Studio scanning, only while a terminal waits for a port,
   * or while someone watches the list and a terminal runs, so the ports it opened stay current.
   */
  #updateWorkspaceWatch(): void {
    const linking =
      this.#processTree !== undefined &&
      this.#watchers.size > 0 &&
      [...this.#entries.values()].some((entry) => entry.info.status === "running");
    const needed = linking || this.#waitingEntries().length > 0;
    if (needed && !this.#stopWorkspaceWatch) {
      this.#stopWorkspaceWatch = this.#workspace.watch(() => {
        if (this.#waitingEntries().length > 0) void this.#nameNewPorts();
        if (this.#watchers.size > 0) void this.#refreshPorts();
      });
    } else if (!needed && this.#stopWorkspaceWatch) {
      this.#stopWorkspaceWatch();
      this.#stopWorkspaceWatch = undefined;
    }
  }

  async #nameNewPorts(): Promise<void> {
    if (this.#naming) return;
    this.#naming = true;
    try {
      const { routes, detected } = await this.#workspace.snapshot();
      for (const entry of this.#waitingEntries()) await this.#nameFor(entry, routes, detected);
    } finally {
      this.#naming = false;
      this.#updateWorkspaceWatch();
    }
  }

  async #nameFor(entry: Entry, routes: Route[], detected: DetectedPort[]): Promise<void> {
    const baseline = entry.baseline ?? new Set<number>();
    const naming = entry.info.naming;
    if (!naming) return;
    const cwd = entry.info.cwd;
    const isNew = (port: number) => !baseline.has(port);

    const port = detected.find(
      (item) => isNew(item.port) && item.cwd !== null && this.#folders.contains(cwd, item.cwd),
    );
    if (port) {
      const name = naming.requested ?? port.suggestedName;
      if (name === null) {
        this.#finishNaming(entry, port.port, null, "Studio has no name to suggest for it.");
        return;
      }
      const created = await this.#workspace.createAlias(name, port.port);
      this.#finishNaming(entry, port.port, created.ok ? name : null, errorText(created));
      return;
    }
    // Auto mode may name the port before this terminal does.
    const route = routes.find((item) => {
      const path = item.project?.path;
      return (
        isNew(item.port) &&
        !!path &&
        (this.#folders.contains(cwd, path) || this.#folders.contains(path, cwd))
      );
    });
    if (!route) return;
    const wanted = naming.requested;
    if (wanted === null || wanted === route.name || route.kind !== "alias") {
      this.#finishNaming(entry, route.port, route.name, undefined);
      return;
    }
    const renamed = await this.#workspace.renameAlias(route.name, wanted);
    this.#finishNaming(entry, route.port, renamed.ok ? wanted : null, errorText(renamed));
  }

  #finishNaming(entry: Entry, port: number, name: string | null, message?: string): void {
    clearTimeout(entry.namingTimer);
    this.#setNaming(
      entry,
      name === null
        ? { state: "failed", port, ...(message ? { message } : {}) }
        : { state: "named", port, name },
    );
    this.#publishStatus(entry);
  }

  #setNaming(entry: Entry, change: Partial<TerminalNaming>): void {
    const naming = entry.info.naming;
    if (!naming) return;
    entry.info = { ...entry.info, naming: { ...naming, ...change } };
  }
}

function readCommand(value: unknown): Result<string | null, AppError> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string") return err(appError("invalid_request", "command must be text."));
  const command = value.trim();
  if (command.length > MAX_COMMAND_CHARS) {
    return err(appError("invalid_request", "The command is too long."));
  }
  return ok(command === "" ? null : command);
}

function readSize(value: unknown, fallback: number): number {
  const size = Number(value);
  return Number.isInteger(size) && size >= 10 && size <= 1000 ? size : fallback;
}

function readNaming(value: CreateTerminalRequest["name"]): TerminalNaming | null {
  if (value === true) return { state: "waiting", requested: null, name: null, port: null };
  if (typeof value === "string" && value.trim() !== "") {
    return { state: "waiting", requested: value.trim(), name: null, port: null };
  }
  return null;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function errorText(result: Result<void, AppError>): string | undefined {
  return result.ok ? undefined : result.error.message;
}

function notFound(id: string): Result<never, AppError> {
  return err(appError("not_found", `No terminal has the id "${id}".`));
}

function notRunning(entry: Entry): Result<never, AppError> {
  return err(
    appError(
      "terminal_not_running",
      `The command in ${entry.info.id} already ended. Restart it first.`,
    ),
  );
}
