import type { StudioConfig } from "../config/studio-config.ts";
import type { DoctorCheck } from "../doctor/doctor-check.ts";
import type { DetectedPort } from "../ports/detected-port.ts";
import type { OtherPort } from "../ports/helper-ports.ts";
import type { CustomApp } from "../projects/custom-app.ts";
import type { ProxyStatus, Route } from "../routes/route.ts";
import type { TerminalInfo } from "../terminals/terminal.ts";

/**
 * The HTTP API between the web app and the server. Both sides import these names, so changing a
 * path or a shape here is a breaking change for any other backend that implements the API.
 */
export const API_PATHS = {
  /** Returns the per-run write token. Same-origin only, so other sites cannot read it. */
  session: "/api/session",
  snapshot: "/api/snapshot",
  /**
   * Server-sent events: one `snapshot` event on connect and after every change, plus one `event`
   * per notable change (`StudioEvent`), the recent ones replayed on connect.
   */
  events: "/api/events",
  aliases: "/api/aliases",
  alias: (name: string) => `/api/aliases/${encodeURIComponent(name)}`,
  /** POST: runs `npm install -g portless` on the server. A write, so it needs the token. */
  installPortless: "/api/portless/install",
  /** GET returns the StudioConfig; PUT replaces it (a write, needs the token). */
  config: "/api/config",
  /** POST: adds the port to `ignoredPorts`, so it stops showing as detected. */
  ignoreDetected: (port: number) => `/api/detected/${port}/ignore`,
  /** GET: runs every health check and returns `DoctorReport`. */
  doctor: "/api/doctor",
  /** POST: runs the safe fix of the check with this id; answers `DoctorFixResponse`. */
  doctorFix: (id: string) => `/api/doctor/fix/${encodeURIComponent(id)}`,
  /** POST: starts, stops or restarts the portless proxy. */
  proxy: (action: ProxyAction) => `/api/proxy/${action}`,
  /** POST: restarts or stops Studio itself; answers 202 before Studio goes away. */
  studio: (action: StudioAction) => `/api/studio/${action}`,
  /** POST: stops a dev server listening on a detected or routed port. */
  stopProcess: (pid: number) => `/api/processes/${pid}/stop`,
  /** POST: runs `docker stop` for a container the last `docker ps` listed. */
  stopContainer: (name: string) => `/api/containers/${encodeURIComponent(name)}/stop`,
  /** GET: the editors found on this machine, the file manager and the custom apps. */
  openWithApps: "/api/open-with/apps",
  /** POST `OpenWithRequest`: opens a folder Studio knows with one of those apps. */
  openWith: "/api/open-with",
  /** GET returns `CustomAppsResponse`; PUT replaces the list (a write, needs the token). */
  customApps: "/api/open-with/custom-apps",
  /**
   * Terminals Studio runs (docs/terminals.md). Every terminal endpoint needs the token, reads too,
   * because output and commands can carry secrets. GET lists them, POST `CreateTerminalRequest`
   * starts one.
   */
  terminals: "/api/terminals",
  /** Server-sent events: `terminals` with the whole list on connect and after every change. */
  terminalsEvents: "/api/terminals/events",
  /**
   * POST `CreateTerminalRequest` from the page's folder picker: `cwd` may be any existing folder,
   * typed by the person (`~` is the home folder). Every other page request runs only in folders
   * Studio shows.
   */
  terminalsInFolder: "/api/terminals/in-folder",
  /** GET returns `RecentCommandsResponse`: the last commands run in each folder. */
  terminalsRecentCommands: "/api/terminals/recent-commands",
  /**
   * GET returns `TerminalInfo`; PATCH `RenameTerminalRequest` renames it; DELETE stops the command
   * if it runs and closes the terminal.
   */
  terminal: (id: string) => `/api/terminals/${encodeURIComponent(id)}`,
  /** GET `?from=<seq>&max=<chars>` returns `TerminalOutputResponse`. */
  terminalOutput: (id: string) => `/api/terminals/${encodeURIComponent(id)}/output`,
  /**
   * Server-sent events `?from=<seq>`: the kept output from `from` as `output`
   * (`TerminalOutputChunk`), then `status` (`TerminalInfo`), then live output and status changes.
   */
  terminalStream: (id: string) => `/api/terminals/${encodeURIComponent(id)}/stream`,
  /** POST `TerminalInputRequest`: writes to the command's stdin. */
  terminalInput: (id: string) => `/api/terminals/${encodeURIComponent(id)}/input`,
  /** POST: Ctrl+C, then SIGTERM, then SIGKILL until the command ends. */
  terminalStop: (id: string) => `/api/terminals/${encodeURIComponent(id)}/stop`,
  /**
   * POST: runs the same command again in the same terminal; also starts a terminal that was
   * stopped by a Studio restart.
   */
  terminalRestart: (id: string) => `/api/terminals/${encodeURIComponent(id)}/restart`,
  /** POST `FocusRequest`: brings a Studio page to the front showing a route, port or terminal. */
  focus: "/api/focus",
  /** POST `FocusAck`: a page says whether it got the window to the front. */
  focusAck: "/api/focus/ack",
  /** GET returns `UpdateStatus`: whether a newer portless-studio is on npm. Read-only. */
  update: "/api/update",
  /** POST: runs `npm install -g portless-studio` on the server. A write, so it needs the token. */
  updateInstall: "/api/update/install",
} as const;

/**
 * Query parameter that carries the token where a header cannot: the browser's EventSource sends
 * no custom headers.
 */
export const TOKEN_PARAM = "token";

/**
 * `GET /api/snapshot?includeStudio=1` keeps Studio's own route in `routes`, which the snapshot
 * leaves out unless `showStudioRoute` is on.
 */
export const INCLUDE_STUDIO_PARAM = "includeStudio";

export type ProxyAction = "start" | "stop" | "restart";
export type StudioAction = "restart" | "stop";

export const SNAPSHOT_EVENT = "snapshot";

/** Server-sent event type that carries one `StudioEvent`. */
export const STUDIO_EVENT = "event";

/**
 * What happened: a dev server appeared (`detected`), a route got a name (`named`) or lost it
 * (`removed`), a route stopped (`down`) or started answering again (`up`), or the proxy started
 * or stopped (`proxy`).
 */
export type StudioEventKind = "detected" | "named" | "removed" | "down" | "up" | "proxy";

/** One notification. The page shows it in the app; the OS can show it too. */
export type StudioEvent = {
  /** Unique for this server run; the page uses it to show each event once. */
  id: string;
  kind: StudioEventKind;
  title: string;
  body: string;
  /** What clicking the notification shows: a route by name, or a port. */
  target: { route?: string; port?: number };
  /** Epoch milliseconds. */
  at: number;
};

/** Server-sent event type on `/api/events` that asks pages to show a target and come forward. */
export const FOCUS_EVENT = "focus";

/** What to bring on screen. Empty means just the Studio page. */
export type FocusTarget = { route?: string; port?: number; terminal?: string };

/** One `focus` event. The page answers with `FocusAck` carrying the same id. */
export type FocusEvent = { id: string; target: FocusTarget };

/** POST /api/focus */
export type FocusRequest = {
  /** A route name, a project name, a terminal id or `port:<number>`; omit for Studio itself. */
  target?: string;
};

/** POST /api/focus, on success. */
export type FocusResponse = {
  target: FocusTarget;
  /** How many open Studio pages got the event. */
  pages: number;
  /** True when a page said its window came to the front. */
  focused: boolean;
  /** True when Studio opened `url` in the browser because no page came forward. */
  opened: boolean;
  /** The page link that shows the target. */
  url: string;
};

/** POST /api/focus/ack */
export type FocusAck = { id: string; focused: boolean };

/** POST /api/terminals */
export type CreateTerminalRequest = {
  /** Folder to run in. From the page it must be a project folder Studio shows. */
  cwd?: string;
  /** Or a project name Studio shows; its folder is used. */
  project?: string;
  /** What to run; omit for an interactive shell. */
  command?: string;
  title?: string;
  /** Size of the terminal that will show it. */
  cols?: number;
  rows?: number;
  /**
   * Name the first new port the command opens in its folder: true for the suggested name, or a
   * name. Used by `portless-studio run`.
   */
  name?: boolean | string;
};

/** PATCH /api/terminals/:id. An empty title gives back the default one, the command or shell. */
export type RenameTerminalRequest = { title: string };

/** GET /api/terminals: running, ended and stopped-by-a-restart terminals alike. */
export type TerminalsResponse = { terminals: TerminalInfo[] };

/** GET /api/terminals/recent-commands */
export type RecentCommandsResponse = {
  /** Folder to its last commands (at most 20), newest first. */
  recentCommands: Record<string, string[]>;
};

/** Server-sent event types on the terminal streams. */
export const TERMINALS_EVENT = "terminals";
export const TERMINAL_STATUS_EVENT = "status";
export const TERMINAL_OUTPUT_EVENT = "output";

/** One `output` event: characters from offset `seq` on. */
export type TerminalOutputChunk = { seq: number; data: string };

/** GET /api/terminals/:id/output */
export type TerminalOutputResponse = {
  terminal: TerminalInfo;
  /** Raw output with escape codes, as the command wrote it. */
  data: string;
  from: number;
  next: number;
  /** True when older output asked for was already dropped. */
  truncated: boolean;
};

/** POST /api/terminals/:id/input */
export type TerminalInputRequest = { text: string };

/** Sent on every Studio response, so one Studio never lists another as a dev server. */
export const STUDIO_HEADER = "x-portless-studio";

/** Header that carries the per-run token on every write request. */
export const TOKEN_HEADER = "x-portless-studio-token";

/** GET /api/session */
export type Session = {
  token: string;
};

/** Whether the portless command runs on the server's machine, and which version it reports. */
export type PortlessInstallation = {
  installed: boolean;
  /** What `portless --version` printed, or null when it is not installed or printed nothing. */
  version: string | null;
};

export type Snapshot = {
  proxy: ProxyStatus;
  portless: PortlessInstallation;
  routes: Route[];
  /** Ports that answer HTTP, are not ignored and have no portless route yet. */
  detected: DetectedPort[];
  /**
   * Detected ports kept out of `detected`: helper ports of a named server, debuggers and ports the
   * system handed out for port 0. Never named by auto mode. Absent from older servers.
   */
  otherPorts?: OtherPort[];
  /** Whether auto mode is on, so the UI can say so without fetching the config. */
  autoName: boolean;
  /**
   * Icon per project name, for group headers: the one set in the config, else the first icon one
   * of its servers has. Absent from older servers.
   */
  projectIcons?: Record<string, string>;
  /** Epoch milliseconds when the server read this state. */
  readAt: number;
};

/** GET /api/update */
export type UpdateStatus = {
  /** The version this Studio runs. */
  current: string;
  /** The latest version on npm, or null when checks are off or none succeeded yet. */
  latest: string | null;
  /** True when `latest` is newer than `current`. */
  available: boolean;
  /** How to update, e.g. `npm i -g portless-studio`. */
  command: string;
};

/** POST /api/update/install, on success. */
export type UpdateInstallResponse = {
  /** The version npm installed. */
  version: string;
  /** What npm printed, without color codes, trimmed to its last few kilobytes. */
  output: string;
};

/** POST /api/aliases */
export type CreateAliasRequest = {
  name: string;
  port: number;
  /** Replace a route that already has this name. */
  force?: boolean;
};

/** PATCH /api/aliases/:name */
export type RenameAliasRequest = {
  name: string;
};

/** POST /api/portless/install, on success. */
export type InstallPortlessResponse = {
  /** The version detected after the install; null when the command still cannot be found. */
  version: string | null;
  /** What npm printed, without color codes, trimmed to its last few kilobytes. */
  output: string;
};

/** `editor` and `file-manager` were found on this machine; `custom` were added in Settings. */
export type OpenWithAppKind = "editor" | "file-manager" | "custom";

export type OpenWithApp = {
  /** Stable for this machine, e.g. `vscode`, `zed`, `file-manager`, `custom-1`. */
  id: string;
  name: string;
  kind: OpenWithAppKind;
};

/** GET /api/open-with/apps */
export type OpenWithAppsResponse = {
  apps: OpenWithApp[];
};

/** POST /api/open-with */
export type OpenWithRequest = {
  appId: string;
  /** Must be the project folder of a route or detected port Studio shows, or showed before. */
  path: string;
};

/** GET and PUT /api/open-with/custom-apps; PUT sends only `apps`. */
export type CustomAppsResponse = {
  apps: CustomApp[];
  /** Where the JSON file lives, so people can edit it by hand. */
  path: string;
};

/** GET /api/doctor */
export type DoctorReport = {
  checks: DoctorCheck[];
};

/** POST /api/doctor/fix/:id, on success: what was done and the checks run again afterwards. */
export type DoctorFixResponse = {
  message: string;
  checks: DoctorCheck[];
};

/** POST /api/proxy/:action, on success. */
export type ProxyActionResponse = {
  message: string;
};

/** POST /api/studio/:action: sent with 202 just before Studio restarts or exits. */
export type StudioActionResponse = {
  message: string;
  /** How to start Studio again after a stop. */
  startCommand: string;
};

/** GET /api/config and the body of PUT /api/config. */
export type ConfigResponse = {
  config: StudioConfig;
  /** Where the JSON file lives, so people can edit it by hand. */
  path: string;
};

export type ApiErrorCode =
  | "invalid_request"
  | "invalid_name"
  | "invalid_port"
  | "name_taken"
  | "not_found"
  | "not_an_alias"
  | "forbidden"
  | "portless_unavailable"
  /** `npm install -g portless` failed; the message carries what npm printed. */
  | "install_failed"
  /** Another install is still running. */
  | "install_in_progress"
  /** PUT /api/config with a value parseConfig rejects; the message names the field. */
  | "invalid_config"
  /** The process belongs to root or another user; the error carries the command to run. */
  | "needs_admin"
  /** The pid does not listen on a detected or routed port, or is not the current user's. */
  | "process_not_allowed"
  /** This system cannot do it, e.g. restarting Studio as a service on Windows. */
  | "unsupported"
  /** A system command failed; the message carries what it printed. */
  | "command_failed"
  /** Another process already listens on the port, e.g. a second portless proxy. */
  | "port_in_use"
  /** No app with that id was found on this machine or among the custom apps. */
  | "unknown_app"
  /** The folder is not one Studio shows, so it will not open it. */
  | "path_not_allowed"
  /** The terminal's command already ended, so it takes no input. */
  | "terminal_not_running"
  /** Studio already runs as many terminals as it allows. */
  | "too_many_terminals"
  | "internal";

/** Body of every non-2xx response. */
export type ApiError = {
  error: ApiErrorCode;
  message: string;
  /** A command the person can copy and run instead, when the server cannot do it. */
  command?: string;
};
