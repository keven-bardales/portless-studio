import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  API_PATHS,
  type CreateAliasRequest,
  type CreateTerminalRequest,
  type DoctorFixResponse,
  type DoctorReport,
  INCLUDE_STUDIO_PARAM,
  type OpenWithAppsResponse,
  type ProxyAction,
  type RecentCommandsResponse,
  type RenameAliasRequest,
  type Session,
  STUDIO_HEADER,
  type StudioAction,
  type StudioActionResponse,
  type TerminalsResponse,
  TOKEN_HEADER,
  TOKEN_PARAM,
  type UpdateInstallResponse,
  type UpdateStatus,
} from "../../../core/api/contract.ts";
import type { Result } from "../../../core/result.ts";
import type { AppError } from "../../application/app-error.ts";
import type { DoctorService } from "../../application/doctor.ts";
import type { OpenWith } from "../../application/open-with.ts";
import type { RouteRegistry } from "../../application/route-registry.ts";
import {
  createAlias,
  installPortless,
  removeAlias,
  renameAlias,
} from "../../application/route-use-cases.ts";
import type { StudioRuntime } from "../../application/studio-runtime.ts";
import type { StudioServiceControl } from "../../application/studio-service.ts";
import type { TerminalManager } from "../../application/terminals.ts";
import { FocusBroker, focusQuery, resolveFocusTarget } from "./focus-broker.ts";
import { type BodyError, MAX_BODY_BYTES, readJsonBody, sendError, sendJson } from "./json-io.ts";
import { hasToken, isAllowedHost, isSameOrigin } from "./request-guards.ts";
import { SnapshotEvents } from "./snapshot-events.ts";
import { StaticFiles } from "./static-files.ts";
import { TerminalStreams } from "./terminal-streams.ts";

export type HttpServerOptions = {
  registry: RouteRegistry;
  /** Builds the full snapshot (routes plus detected ports) and owns the config. */
  studio: StudioRuntime;
  /** Per-run secret every write request must carry in `TOKEN_HEADER`. */
  token: string;
  /** Built web app to serve. Without it the server answers only the API. */
  webDir?: string | undefined;
  /** Health checks and their fixes; without it `/api/doctor` answers `unsupported`. */
  doctor?: DoctorService;
  controlProxy?: (action: ProxyAction) => Promise<Result<string, AppError>>;
  /** Restarts or stops Studio itself; given by the CLI, which knows how Studio was started. */
  studioService?: StudioServiceControl;
  /** Stops a dev server by pid, after checking it is the user's and listens on a shown port. */
  stopProcess?: (pid: string, all?: boolean) => Promise<Result<unknown, AppError>>;
  /** Stops a Docker container by name, only one the last `docker ps` listed. */
  stopContainer?: (name: string) => Promise<Result<unknown, AppError>>;
  /** Opens project folders in editors; without it the open-with endpoints answer `unsupported`. */
  openWith?: OpenWith;
  /** Runs terminals; without it the terminal endpoints answer `unsupported`. */
  terminals?: TerminalManager;
  /** Opens a link in the browser, for focus requests no open page answers. */
  openUrl?: (url: string) => void;
  /**
   * Whether a newer release exists, and installing it; without it `/api/update` and
   * `/api/update/install` answer `unsupported`.
   */
  updates?: {
    status(): Promise<UpdateStatus>;
    install(): Promise<Result<UpdateInstallResponse, AppError>>;
  };
};

export type HttpServer = {
  server: Server;
  /** Ends open event streams; call before `server.close()`. */
  closeStreams(): void;
};

const ALIAS_PREFIX = `${API_PATHS.aliases}/`;
const IGNORE_DETECTED = /^\/api\/detected\/([^/]+)\/ignore$/;
const DOCTOR_FIX = /^\/api\/doctor\/fix\/([^/]+)$/;
const PROXY_ACTION = /^\/api\/proxy\/(start|stop|restart)$/;
const STUDIO_ACTION = /^\/api\/studio\/(restart|stop)$/;
const STOP_PROCESS = /^\/api\/processes\/([^/]+)\/stop$/;
const STOP_CONTAINER = /^\/api\/containers\/([^/]+)\/stop$/;
const TERMINAL = /^\/api\/terminals\/([^/]+)(?:\/(output|stream|input|stop|restart))?$/;
/** Lets the 202 reach the browser before Studio restarts or exits. */
const STUDIO_ACTION_DELAY_MS = 200;
const unsupported: AppError = { code: "unsupported", message: "This Studio cannot do that." };

export function createHttpServer(options: HttpServerOptions): HttpServer {
  const events = new SnapshotEvents(options.studio);
  const staticFiles = options.webDir ? new StaticFiles(options.webDir) : null;
  const terminalStreams = options.terminals ? new TerminalStreams(options.terminals) : null;
  const focus = new FocusBroker({
    send: (event) => events.broadcastFocus(event),
    openUrl: options.openUrl,
  });

  const server = createServer((req, res) => {
    res.setHeader(STUDIO_HEADER, "1");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, "internal", "Unexpected server error.");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { host, origin } = req.headers;
    if (!isAllowedHost(host) || !isSameOrigin(origin, host)) {
      sendError(res, "forbidden", "Requests must come from this machine and this page.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, url.searchParams);
      return;
    }
    if (staticFiles) {
      staticFiles.serve(req, res, pathname);
      return;
    }
    res
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end("The web app is not built. Run it with `pnpm dev:web`.");
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ) {
    const method = req.method ?? "GET";
    const isRead = method === "GET" || method === "HEAD";
    if (!isRead && !hasToken(req.headers[TOKEN_HEADER], options.token)) {
      sendError(res, "forbidden", "Missing or wrong session token.");
      return;
    }
    if (pathname === API_PATHS.terminals || pathname.startsWith(`${API_PATHS.terminals}/`)) {
      // Terminal output and commands can carry secrets, so reads need the token too.
      const token = req.headers[TOKEN_HEADER] ?? query.get(TOKEN_PARAM) ?? undefined;
      if (!hasToken(token, options.token)) {
        sendError(res, "forbidden", "Missing or wrong session token.");
        return;
      }
      return handleTerminals(req, res, pathname, method, query);
    }
    if (pathname === API_PATHS.focus && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const target = asRecord(body.value).target;
      const resolved = resolveFocusTarget(
        typeof target === "string" ? target : undefined,
        await options.studio.readSnapshot(),
        options.terminals?.list() ?? [],
      );
      if (!resolved.ok) return sendAppError(res, resolved.error);
      const pageUrl = await options.studio.pageUrl(focusQuery(resolved.value));
      return sendJson(res, 200, await focus.focus(resolved.value, pageUrl));
    }
    if (pathname === API_PATHS.focusAck && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const fields = asRecord(body.value);
      if (typeof fields.id === "string")
        focus.ack({ id: fields.id, focused: fields.focused === true });
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
      return;
    }

    if (pathname === API_PATHS.session && method === "GET") {
      const session: Session = { token: options.token };
      sendJson(res, 200, session);
      return;
    }
    if (pathname === API_PATHS.snapshot && method === "GET") {
      const includeStudio = query.get(INCLUDE_STUDIO_PARAM) === "1";
      sendJson(res, 200, await options.studio.readSnapshot({ includeStudio }));
      return;
    }
    if (pathname === API_PATHS.update && method === "GET") {
      if (!options.updates) return sendAppError(res, unsupported);
      return sendJson(res, 200, await options.updates.status());
    }
    if (pathname === API_PATHS.updateInstall && method === "POST") {
      if (!options.updates) return sendAppError(res, unsupported);
      const result = await options.updates.install();
      if (!result.ok) return sendAppError(res, result.error);
      return sendJson(res, 200, result.value);
    }
    if (pathname === API_PATHS.config && method === "GET") {
      const result = await options.studio.readConfig();
      if (!result.ok) return sendError(res, result.error.code, result.error.message);
      return sendJson(res, 200, result.value);
    }
    if (pathname === API_PATHS.config && method === "PUT") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const result = await options.studio.updateConfig(body.value);
      if (!result.ok) return sendError(res, result.error.code, result.error.message);
      return sendJson(res, 200, result.value);
    }
    const ignored = IGNORE_DETECTED.exec(pathname);
    if (ignored?.[1] && method === "POST") {
      return sendResult(res, await options.studio.ignorePort(ignored[1]), 204);
    }
    if (pathname === API_PATHS.doctor && method === "GET") {
      if (!options.doctor) return sendAppError(res, unsupported);
      const report: DoctorReport = { checks: await options.doctor.check() };
      return sendJson(res, 200, report);
    }
    const fix = DOCTOR_FIX.exec(pathname);
    if (fix?.[1] && method === "POST") {
      if (!options.doctor) return sendAppError(res, unsupported);
      const id = decodeName(fix[1]);
      if (id === null) return sendError(res, "not_found", "No check has that id.");
      const result = await options.doctor.fix(id);
      if (!result.ok) return sendAppError(res, result.error);
      const body: DoctorFixResponse = result.value;
      return sendJson(res, 200, body);
    }
    const proxyAction = PROXY_ACTION.exec(pathname)?.[1] as ProxyAction | undefined;
    if (proxyAction && method === "POST") {
      if (!options.controlProxy) return sendAppError(res, unsupported);
      const result = await options.controlProxy(proxyAction);
      if (!result.ok) return sendAppError(res, result.error);
      return sendJson(res, 200, { message: result.value });
    }
    const studioAction = STUDIO_ACTION.exec(pathname)?.[1] as StudioAction | undefined;
    if (studioAction && method === "POST") {
      if (!options.studioService) return sendAppError(res, unsupported);
      const prepared = await options.studioService.prepare(studioAction);
      if (!prepared.ok) return sendAppError(res, prepared.error);
      const { message, startCommand, run } = prepared.value;
      const body: StudioActionResponse = { message, startCommand };
      res.once("finish", () => setTimeout(() => void run(), STUDIO_ACTION_DELAY_MS));
      return sendJson(res, 202, body);
    }
    const stop = STOP_PROCESS.exec(pathname);
    if (stop?.[1] && method === "POST") {
      if (!options.stopProcess) return sendAppError(res, unsupported);
      const result = await options.stopProcess(stop[1], query.get("scope") === "tree");
      if (!result.ok) return sendAppError(res, result.error);
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
      return;
    }
    const stopBox = STOP_CONTAINER.exec(pathname);
    if (stopBox?.[1] && method === "POST") {
      if (!options.stopContainer) return sendAppError(res, unsupported);
      const result = await options.stopContainer(decodeName(stopBox[1]) ?? "");
      if (!result.ok) return sendAppError(res, result.error);
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (pathname.startsWith(`${API_PATHS.openWith}/`) || pathname === API_PATHS.openWith) {
      return handleOpenWith(req, res, pathname, method);
    }
    if (pathname === API_PATHS.events && method === "GET") {
      await events.connect(res);
      return;
    }
    if (pathname === API_PATHS.aliases && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const result = await createAlias(options.registry, toCreateRequest(body.value));
      return sendResult(res, result, 201);
    }
    if (pathname === API_PATHS.installPortless && method === "POST") {
      const result = await installPortless(options.registry);
      if (!result.ok) return sendError(res, result.error.code, result.error.message);
      await options.studio.ensureProxy();
      return sendJson(res, 200, result.value);
    }
    if (pathname.startsWith(ALIAS_PREFIX) && (method === "PATCH" || method === "DELETE")) {
      const name = decodeName(pathname.slice(ALIAS_PREFIX.length));
      if (name === null) return sendError(res, "not_found", "No route has that name.");
      if (method === "DELETE") {
        return sendResult(res, await removeAlias(options.registry, name), 204);
      }
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const result = await renameAlias(options.registry, name, toRenameRequest(body.value));
      return sendResult(res, result, 204);
    }
    sendError(res, "not_found", `No API endpoint for ${method} ${pathname}.`);
  }

  async function handleTerminals(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    method: string,
    query: URLSearchParams,
  ): Promise<void> {
    const terminals = options.terminals;
    if (!terminals || !terminalStreams) return sendAppError(res, unsupported);
    if (pathname === API_PATHS.terminals && method === "GET") {
      const body: TerminalsResponse = { terminals: terminals.list() };
      return sendJson(res, 200, body);
    }
    if (pathname === API_PATHS.terminals && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const created = await terminals.create(toTerminalRequest(body.value), {
        trusted: isLocalProgram(req),
      });
      if (!created.ok) return sendAppError(res, created.error);
      return sendJson(res, 201, created.value);
    }
    if (pathname === API_PATHS.terminalsRecentCommands && method === "GET") {
      const body: RecentCommandsResponse = { recentCommands: terminals.recentCommands() };
      return sendJson(res, 200, body);
    }
    if (pathname === API_PATHS.terminalsEvents && method === "GET") {
      terminalStreams.list(res);
      return;
    }
    if (pathname === API_PATHS.terminalsInFolder && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const created = await terminals.create(toTerminalRequest(body.value), {
        trusted: isLocalProgram(req),
        picked: true,
      });
      if (!created.ok) return sendAppError(res, created.error);
      return sendJson(res, 201, created.value);
    }
    const match = TERMINAL.exec(pathname);
    const id = match?.[1] ? decodeName(match[1]) : null;
    if (id === null) return sendError(res, "not_found", "No terminal has that id.");
    const action = match?.[2];
    if (action === undefined && method === "GET") {
      const info = terminals.get(id);
      if (!info) return sendError(res, "not_found", `No terminal has the id "${id}".`);
      return sendJson(res, 200, info);
    }
    if (action === undefined && method === "PATCH") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const title = asRecord(body.value).title;
      if (typeof title !== "string")
        return sendError(res, "invalid_request", "title must be text.");
      const renamed = terminals.rename(id, title);
      if (!renamed.ok) return sendAppError(res, renamed.error);
      return sendJson(res, 200, renamed.value);
    }
    if (action === undefined && method === "DELETE") {
      return sendResult(res, terminals.remove(id), 204);
    }
    if (action === "output" && method === "GET") {
      const max = Number(query.get("max"));
      const read = terminals.read(
        id,
        readOffset(query.get("from")),
        Number.isInteger(max) && max > 0 ? max : undefined,
      );
      if (!read.ok) return sendAppError(res, read.error);
      return sendJson(res, 200, read.value);
    }
    if (action === "stream" && method === "GET") {
      const streamed = terminalStreams.terminal(res, id, readOffset(query.get("from")));
      if (!streamed.ok) sendAppError(res, streamed.error);
      return;
    }
    if (action === "input" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const text = asRecord(body.value).text;
      if (typeof text !== "string") return sendError(res, "invalid_request", "text must be text.");
      return sendResult(res, terminals.input(id, text), 204);
    }
    if (action === "stop" && method === "POST") {
      const stopped = terminals.stop(id);
      if (!stopped.ok) return sendAppError(res, stopped.error);
      return sendJson(res, 200, stopped.value);
    }
    if (action === "restart" && method === "POST") {
      const restarted = await terminals.restart(id);
      if (!restarted.ok) return sendAppError(res, restarted.error);
      return sendJson(res, 200, restarted.value);
    }
    sendError(res, "not_found", `No API endpoint for ${method} ${pathname}.`);
  }

  async function handleOpenWith(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    method: string,
  ): Promise<void> {
    const openWith = options.openWith;
    if (!openWith) return sendAppError(res, unsupported);
    if (pathname === API_PATHS.openWithApps && method === "GET") {
      const body: OpenWithAppsResponse = { apps: await openWith.apps() };
      return sendJson(res, 200, body);
    }
    if (pathname === API_PATHS.openWith && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      return sendResult(res, await openWith.open(body.value), 204);
    }
    if (pathname === API_PATHS.customApps && method === "GET") {
      return sendJson(res, 200, await openWith.readCustomApps());
    }
    if (pathname === API_PATHS.customApps && method === "PUT") {
      const body = await readJsonBody(req);
      if (!body.ok) return sendBodyError(res, body.error);
      const result = await openWith.updateCustomApps(body.value);
      if (!result.ok) return sendAppError(res, result.error);
      return sendJson(res, 200, result.value);
    }
    sendError(res, "not_found", `No API endpoint for ${method} ${pathname}.`);
  }

  return {
    server,
    closeStreams: () => {
      events.close();
      terminalStreams?.close();
    },
  };
}

function sendAppError(res: ServerResponse, error: AppError): void {
  sendError(res, error.code, error.message, undefined, error.command);
}

function sendResult(res: ServerResponse, result: Result<void, AppError>, status: number): void {
  if (!result.ok) {
    sendAppError(res, result.error);
    return;
  }
  res.writeHead(status, { "Cache-Control": "no-store" }).end();
}

// The contract has no generic "bad request" code; a body we cannot read carries no valid name.
function sendBodyError(res: ServerResponse, error: BodyError): void {
  if (error === "too_large") {
    sendError(
      res,
      "invalid_request",
      `The request body is larger than ${MAX_BODY_BYTES} bytes.`,
      413,
    );
    return;
  }
  sendError(res, "invalid_request", "The request body is not valid JSON.");
}

function toCreateRequest(body: unknown): CreateAliasRequest {
  const fields = asRecord(body);
  return {
    name: typeof fields.name === "string" ? fields.name : "",
    port:
      typeof fields.port === "number" || typeof fields.port === "string" ? Number(fields.port) : 0,
    force: fields.force === true,
  };
}

function toRenameRequest(body: unknown): RenameAliasRequest {
  const fields = asRecord(body);
  return { name: typeof fields.name === "string" ? fields.name : "" };
}

function toTerminalRequest(body: unknown): CreateTerminalRequest {
  const fields = asRecord(body);
  const request: CreateTerminalRequest = {};
  for (const key of ["cwd", "project", "command", "title"] as const) {
    const value = fields[key];
    if (typeof value === "string") request[key] = value;
  }
  for (const key of ["cols", "rows"] as const) {
    const value = fields[key];
    if (typeof value === "number") request[key] = value;
  }
  if (typeof fields.name === "string" || typeof fields.name === "boolean") {
    request.name = fields.name;
  }
  return request;
}

/**
 * A program on this machine (the CLI or the MCP server) rather than a page: browsers send
 * `Origin` with every POST and `Sec-Fetch-Site` with every request; node:http sends neither.
 */
function isLocalProgram(req: IncomingMessage): boolean {
  return req.headers.origin === undefined && req.headers["sec-fetch-site"] === undefined;
}

function readOffset(value: string | null): number {
  const offset = Number(value ?? 0);
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function decodeName(encoded: string): string | null {
  if (encoded === "" || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
