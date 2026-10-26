import {
  API_PATHS,
  type ApiError,
  type ConfigResponse,
  type CreateAliasRequest,
  type CustomAppsResponse,
  type DoctorFixResponse,
  type DoctorReport,
  FOCUS_EVENT,
  type FocusAck,
  type FocusEvent,
  type InstallPortlessResponse,
  type OpenWithApp,
  type OpenWithRequest,
  type ProxyAction,
  type ProxyActionResponse,
  type RenameAliasRequest,
  type Session,
  SNAPSHOT_EVENT,
  type Snapshot,
  STUDIO_EVENT,
  type StudioAction,
  type StudioActionResponse,
  type StudioEvent,
  TOKEN_HEADER,
  type UpdateInstallResponse,
  type UpdateStatus,
} from "../../../../core/api/contract.ts";
import { parseConfig, type StudioConfig } from "../../../../core/config/studio-config.ts";
import type { DoctorCheck } from "../../../../core/doctor/doctor-check.ts";
import { type CustomApp, isCustomApp } from "../../../../core/projects/custom-app.ts";
import { err, ok, type Result } from "../../../../core/result.ts";
import type {
  ConnectionListener,
  EventListener,
  FocusListener,
  RoutesGateway,
  SnapshotListener,
} from "./routes-gateway.ts";

type HttpRoutesGatewayOptions = {
  /** Origin of the API. Empty means the page's own origin, which is how the server serves it. */
  baseUrl?: string;
  fetch?: typeof fetch;
  createEventSource?: (url: string) => EventSource;
  /** Waits between reconnect attempts, in milliseconds; the last one repeats. */
  reconnectDelays?: readonly number[];
};

const DEFAULT_RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10_000];

const unreachable: ApiError = {
  error: "internal",
  message: "Could not reach the Portless Studio server. Is it still running?",
};

/** `RoutesGateway` over the HTTP API in `core/api/contract.ts`, with live updates through SSE. */
export class HttpRoutesGateway implements RoutesGateway {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #createEventSource: (url: string) => EventSource;
  readonly #reconnectDelays: readonly number[];
  // Fetched on the first write and reused; cleared when the server says it is no longer valid.
  #token: Promise<Result<string, ApiError>> | null = null;

  constructor(options: HttpRoutesGatewayOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "";
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#createEventSource = options.createEventSource ?? ((url) => new EventSource(url));
    this.#reconnectDelays = options.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS;
  }

  async getSnapshot(): Promise<Result<Snapshot, ApiError>> {
    const response = await this.#request(API_PATHS.snapshot, { method: "GET" });
    if (!response.ok) return response;
    const snapshot = toSnapshot(response.value);
    return snapshot
      ? ok(snapshot)
      : err({ error: "internal", message: "The server sent a snapshot this app cannot read." });
  }

  subscribe(
    listener: SnapshotListener,
    onConnectionChange?: ConnectionListener,
    onEvent?: EventListener,
    onFocus?: FocusListener,
  ): () => void {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;

    const connect = () => {
      source = this.#createEventSource(this.#url(API_PATHS.events));
      source.onopen = () => {
        failures = 0;
        onConnectionChange?.("open");
      };
      source.addEventListener(SNAPSHOT_EVENT, (event) => {
        const snapshot = parseSnapshot((event as MessageEvent<string>).data);
        if (snapshot) listener(snapshot);
      });
      source.addEventListener(STUDIO_EVENT, (event) => {
        const studioEvent = toStudioEvent(parseJson((event as MessageEvent<string>).data));
        if (studioEvent) onEvent?.(studioEvent);
      });
      source.addEventListener(FOCUS_EVENT, (event) => {
        const focus = toFocusEvent(parseJson((event as MessageEvent<string>).data));
        if (focus) onFocus?.(focus);
      });
      // We reconnect ourselves: the browser gives up for good after some server errors.
      source.onerror = () => {
        source?.close();
        source = null;
        if (stopped) return;
        onConnectionChange?.("reconnecting");
        const delays = this.#reconnectDelays;
        const delay = delays[Math.min(failures, delays.length - 1)] ?? 1000;
        failures += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    onConnectionChange?.("connecting");
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
      source = null;
    };
  }

  acknowledgeFocus(ack: FocusAck): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.focusAck, "POST", ack);
  }

  createAlias(request: CreateAliasRequest): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.aliases, "POST", request);
  }

  renameAlias(currentName: string, request: RenameAliasRequest): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.alias(currentName), "PATCH", request);
  }

  removeAlias(name: string): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.alias(name), "DELETE");
  }

  async installPortless(): Promise<Result<InstallPortlessResponse, ApiError>> {
    const response = await this.#send(API_PATHS.installPortless, "POST");
    if (!response.ok) return response;
    const body = response.value as Partial<InstallPortlessResponse> | null;
    return ok({
      version: typeof body?.version === "string" ? body.version : null,
      output: typeof body?.output === "string" ? body.output : "",
    });
  }

  async getConfig(): Promise<Result<ConfigResponse, ApiError>> {
    const response = await this.#request(API_PATHS.config, { method: "GET" });
    return response.ok ? readConfigResponse(response.value) : response;
  }

  async updateConfig(config: StudioConfig): Promise<Result<ConfigResponse, ApiError>> {
    const response = await this.#send(API_PATHS.config, "PUT", config);
    return response.ok ? readConfigResponse(response.value) : response;
  }

  ignoreDetected(port: number): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.ignoreDetected(port), "POST");
  }

  async getUpdateStatus(): Promise<Result<UpdateStatus, ApiError>> {
    const response = await this.#request(API_PATHS.update, { method: "GET" });
    if (!response.ok) return response;
    const status = readUpdateStatus(response.value);
    return status ? ok(status) : unreadable("an update status");
  }

  async installUpdate(): Promise<Result<UpdateInstallResponse, ApiError>> {
    const response = await this.#send(API_PATHS.updateInstall, "POST");
    if (!response.ok) return response;
    const installed = readUpdateInstallResponse(response.value);
    return installed ? ok(installed) : unreadable("an update result");
  }

  async getDoctor(): Promise<Result<DoctorReport, ApiError>> {
    const response = await this.#request(API_PATHS.doctor, { method: "GET" });
    if (!response.ok) return response;
    const checks = readChecks(response.value);
    return checks ? ok({ checks }) : unreadable("health checks");
  }

  async runDoctorFix(id: string): Promise<Result<DoctorFixResponse, ApiError>> {
    const response = await this.#send(API_PATHS.doctorFix(id), "POST");
    if (!response.ok) return response;
    const checks = readChecks(response.value);
    return checks
      ? ok({ message: readMessage(response.value), checks })
      : unreadable("health checks");
  }

  async controlProxy(action: ProxyAction): Promise<Result<ProxyActionResponse, ApiError>> {
    const response = await this.#send(API_PATHS.proxy(action), "POST");
    return response.ok ? ok({ message: readMessage(response.value) }) : response;
  }

  async controlStudio(action: StudioAction): Promise<Result<StudioActionResponse, ApiError>> {
    const response = await this.#send(API_PATHS.studio(action), "POST");
    if (!response.ok) return response;
    const body = response.value as Partial<StudioActionResponse> | null;
    return ok({
      message: readMessage(body),
      startCommand: typeof body?.startCommand === "string" ? body.startCommand : "portless-studio",
    });
  }

  stopProcess(pid: number, all?: boolean): Promise<Result<null, ApiError>> {
    return this.#write(`${API_PATHS.stopProcess(pid)}${all ? "?scope=tree" : ""}`, "POST");
  }

  stopContainer(name: string): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.stopContainer(name), "POST");
  }

  async listOpenWithApps(): Promise<Result<OpenWithApp[], ApiError>> {
    const response = await this.#request(API_PATHS.openWithApps, { method: "GET" });
    if (!response.ok) return response;
    const apps = (response.value as { apps?: unknown } | null)?.apps;
    return Array.isArray(apps) ? ok(apps.filter(isOpenWithApp)) : unreadable("apps");
  }

  openWith(request: OpenWithRequest): Promise<Result<null, ApiError>> {
    return this.#write(API_PATHS.openWith, "POST", request);
  }

  async getCustomApps(): Promise<Result<CustomAppsResponse, ApiError>> {
    const response = await this.#request(API_PATHS.customApps, { method: "GET" });
    return response.ok ? readCustomApps(response.value) : response;
  }

  async updateCustomApps(apps: CustomApp[]): Promise<Result<CustomAppsResponse, ApiError>> {
    const response = await this.#send(API_PATHS.customApps, "PUT", { apps });
    return response.ok ? readCustomApps(response.value) : response;
  }

  async #write(path: string, method: string, body?: unknown): Promise<Result<null, ApiError>> {
    const response = await this.#send(path, method, body);
    return response.ok ? ok(null) : response;
  }

  /** A request that changes state: carries the session token and retries once with a new one. */
  async #send(path: string, method: string, body?: unknown): Promise<Result<unknown, ApiError>> {
    const attempt = async (): Promise<Result<unknown, ApiError>> => {
      const token = await this.#getToken();
      if (!token.ok) return token;
      const headers: Record<string, string> = { [TOKEN_HEADER]: token.value };
      if (body !== undefined) headers["content-type"] = "application/json";
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      return this.#request(path, init);
    };

    const first = await attempt();
    // A restarted server issues a new token; fetch it once and try again.
    if (!first.ok && first.error.error === "forbidden") {
      this.#token = null;
      return attempt();
    }
    return first;
  }

  #getToken(): Promise<Result<string, ApiError>> {
    this.#token ??= this.#request(API_PATHS.session, { method: "GET" }).then((response) => {
      if (!response.ok) return response;
      const session = response.value as Partial<Session> | null;
      return typeof session?.token === "string"
        ? ok(session.token)
        : err<ApiError>({
            error: "internal",
            message: "The server did not return a session token.",
          });
    });
    const token = this.#token;
    // Do not keep a failure cached: the next write should ask again.
    token.then((result) => {
      if (!result.ok && this.#token === token) this.#token = null;
    });
    return token;
  }

  async #request(path: string, init: RequestInit): Promise<Result<unknown, ApiError>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url(path), {
        ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string>) },
      });
    } catch {
      return err(unreachable);
    }

    const text = await response.text().catch(() => "");
    const body = parseJson(text);
    if (response.ok) return ok(body);
    return err(
      isApiError(body)
        ? body
        : { error: "internal", message: `The server answered ${response.status}.` },
    );
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseSnapshot(data: string): Snapshot | null {
  return toSnapshot(parseJson(data));
}

/** Checks the parts the UI relies on; fields a server older than this app lacks get defaults. */
function toSnapshot(value: unknown): Snapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Snapshot>;
  const valid =
    Array.isArray(candidate.routes) &&
    typeof candidate.proxy === "object" &&
    candidate.proxy !== null;
  if (!valid) return null;
  return {
    ...(candidate as Snapshot),
    detected: Array.isArray(candidate.detected) ? candidate.detected : [],
    autoName: candidate.autoName === true,
  };
}

const EVENT_KINDS = new Set(["detected", "named", "removed", "down", "up", "proxy"]);

/** An event this app can show, or null; unknown kinds from a newer server are skipped. */
function toStudioEvent(value: unknown): StudioEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Partial<StudioEvent>;
  const valid =
    typeof event.id === "string" &&
    typeof event.kind === "string" &&
    EVENT_KINDS.has(event.kind) &&
    typeof event.title === "string" &&
    typeof event.body === "string" &&
    typeof event.at === "number" &&
    typeof event.target === "object" &&
    event.target !== null;
  return valid ? (event as StudioEvent) : null;
}

function toFocusEvent(value: unknown): FocusEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Partial<FocusEvent>;
  return typeof event.id === "string" && typeof event.target === "object" && event.target !== null
    ? (event as FocusEvent)
    : null;
}

function readConfigResponse(value: unknown): Result<ConfigResponse, ApiError> {
  const body = value as Partial<ConfigResponse> | null;
  const config = parseConfig(body?.config);
  if (!config.ok || typeof body?.path !== "string") {
    return err({ error: "internal", message: "The server sent settings this app cannot read." });
  }
  return ok({ config: config.value, path: body.path });
}

const APP_KINDS = new Set(["editor", "file-manager", "custom"]);

function isOpenWithApp(value: unknown): value is OpenWithApp {
  if (typeof value !== "object" || value === null) return false;
  const app = value as Partial<OpenWithApp>;
  return (
    typeof app.id === "string" &&
    typeof app.name === "string" &&
    typeof app.kind === "string" &&
    APP_KINDS.has(app.kind)
  );
}

function readCustomApps(value: unknown): Result<CustomAppsResponse, ApiError> {
  const body = value as Partial<CustomAppsResponse> | null;
  if (!Array.isArray(body?.apps) || typeof body.path !== "string") return unreadable("apps");
  return ok({ apps: body.apps.filter(isCustomApp), path: body.path });
}

function readChecks(value: unknown): DoctorCheck[] | null {
  const checks = (value as { checks?: unknown } | null)?.checks;
  return Array.isArray(checks) ? (checks as DoctorCheck[]) : null;
}

function readMessage(value: unknown): string {
  const message = (value as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

function readUpdateStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const { current, latest, available, command } = value as Record<string, unknown>;
  if (typeof current !== "string" || typeof command !== "string") return null;
  if (latest !== null && typeof latest !== "string") return null;
  if (typeof available !== "boolean") return null;
  return { current, latest, available, command };
}

function readUpdateInstallResponse(value: unknown): UpdateInstallResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, output } = value as Record<string, unknown>;
  if (typeof version !== "string" || typeof output !== "string") return null;
  return { version, output };
}

function unreadable(what: string): Result<never, ApiError> {
  return err({ error: "internal", message: `The server sent ${what} this app cannot read.` });
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiError>;
  return typeof candidate.error === "string" && typeof candidate.message === "string";
}
