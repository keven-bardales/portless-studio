import type {
  ApiError,
  ConfigResponse,
  CreateAliasRequest,
  CustomAppsResponse,
  DoctorFixResponse,
  DoctorReport,
  FocusAck,
  FocusEvent,
  InstallPortlessResponse,
  OpenWithApp,
  OpenWithRequest,
  ProxyAction,
  ProxyActionResponse,
  RenameAliasRequest,
  Snapshot,
  StudioAction,
  StudioActionResponse,
  StudioEvent,
  UpdateInstallResponse,
  UpdateStatus,
} from "../../../../core/api/contract.ts";
import type { StudioConfig } from "../../../../core/config/studio-config.ts";
import type { CustomApp } from "../../../../core/projects/custom-app.ts";
import type { Result } from "../../../../core/result.ts";

/** Whether live updates are flowing. `reconnecting` means the last snapshot may be stale. */
export type ConnectionState = "connecting" | "open" | "reconnecting";

export type SnapshotListener = (snapshot: Snapshot) => void;
export type ConnectionListener = (state: ConnectionState) => void;
/** Gets each notable change; the recent ones arrive again after every (re)connect. */
export type EventListener = (event: StudioEvent) => void;
/** Gets each request to show something and bring the page forward (`portless-studio open`). */
export type FocusListener = (event: FocusEvent) => void;

/**
 * Everything the routes feature needs from a backend. The UI depends only on this port, so a
 * different backend is one new class that implements it (see docs/architecture.md).
 */
export interface RoutesGateway {
  /** Reads the current state once. */
  getSnapshot(): Promise<Result<Snapshot, ApiError>>;
  /**
   * Calls `listener` with every new snapshot, and `onEvent` with every notable change, until the
   * returned function is called.
   */
  subscribe(
    listener: SnapshotListener,
    onConnectionChange?: ConnectionListener,
    onEvent?: EventListener,
    onFocus?: FocusListener,
  ): () => void;
  /** Tells the server whether the page came to the front after a focus request. */
  acknowledgeFocus?(ack: FocusAck): Promise<Result<null, ApiError>>;
  /** Also names a detected port: it then leaves `detected` and shows up in `routes`. */
  createAlias(request: CreateAliasRequest): Promise<Result<null, ApiError>>;
  renameAlias(currentName: string, request: RenameAliasRequest): Promise<Result<null, ApiError>>;
  removeAlias(name: string): Promise<Result<null, ApiError>>;
  /** Runs `npm install -g portless` on the server; resolves when npm finishes. */
  installPortless(): Promise<Result<InstallPortlessResponse, ApiError>>;
  /** The Studio settings and the path of the JSON file they live in. */
  getConfig(): Promise<Result<ConfigResponse, ApiError>>;
  /** Replaces the settings; fails with `invalid_config` naming the field it rejects. */
  updateConfig(config: StudioConfig): Promise<Result<ConfigResponse, ApiError>>;
  /** Stops showing a detected port by adding it to the ignored ports. */
  ignoreDetected(port: number): Promise<Result<null, ApiError>>;
  /** Whether a newer portless-studio is on npm; backends without update checks leave it out. */
  getUpdateStatus?(): Promise<Result<UpdateStatus, ApiError>>;
  /** Runs `npm install -g portless-studio` on the server; backends without it leave it out. */
  installUpdate?(): Promise<Result<UpdateInstallResponse, ApiError>>;
  /** Runs the health checks. */
  getDoctor(): Promise<Result<DoctorReport, ApiError>>;
  /** Runs the safe fix of one check and returns the checks again. */
  runDoctorFix(id: string): Promise<Result<DoctorFixResponse, ApiError>>;
  /** Starts, stops or restarts the portless proxy; `needs_admin` carries the sudo command. */
  controlProxy(action: ProxyAction): Promise<Result<ProxyActionResponse, ApiError>>;
  /** Restarts or stops Studio itself; the answer arrives just before it goes away. */
  controlStudio(action: StudioAction): Promise<Result<StudioActionResponse, ApiError>>;
  /** Stops the dev server with this pid, if it is the user's and serves a shown port. */
  stopProcess(pid: number, all?: boolean): Promise<Result<null, ApiError>>;
  /** Stops a Docker container a detected row shows, by its name. */
  stopContainer(name: string): Promise<Result<null, ApiError>>;
  /** Editors and the file manager found on the server's machine, then the custom apps. */
  listOpenWithApps(): Promise<Result<OpenWithApp[], ApiError>>;
  /** Opens a project folder Studio shows; `path_not_allowed` for any other folder. */
  openWith(request: OpenWithRequest): Promise<Result<null, ApiError>>;
  /** The apps added in Settings and the file they live in. */
  getCustomApps(): Promise<Result<CustomAppsResponse, ApiError>>;
  /** Replaces the custom apps; fails with `invalid_request` naming the entry it rejects. */
  updateCustomApps(apps: CustomApp[]): Promise<Result<CustomAppsResponse, ApiError>>;
}
