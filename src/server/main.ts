import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ProxyAction } from "../core/api/contract.ts";
import type { DetectedPort } from "../core/ports/detected-port.ts";
import type { Result } from "../core/result.ts";
import type { AppError } from "./application/app-error.ts";
import type { AutoNamedStore } from "./application/auto-named-store.ts";
import type { ConfigStore } from "./application/config-store.ts";
import { stopContainer } from "./application/container-source.ts";
import { createDoctorService, type DoctorService } from "./application/doctor.ts";
import { OpenWith } from "./application/open-with.ts";
import type { PortScanner } from "./application/port-scanner.ts";
import type { ProcessOwner } from "./application/process-control.ts";
import { controlProxy } from "./application/proxy-control.ts";
import { confirmProxyStarts } from "./application/proxy-start-check.ts";
import type { RouteRegistry } from "./application/route-registry.ts";
import { createAlias, renameAlias } from "./application/route-use-cases.ts";
import { publicUrls, SHORT_URL_PORT, ShortUrls } from "./application/short-urls.ts";
import { stopProcess } from "./application/stop-process.ts";
import { StudioRuntime } from "./application/studio-runtime.ts";
import type { StudioServiceControl } from "./application/studio-service.ts";
import { TerminalManager, type TerminalSpawner } from "./application/terminals.ts";
import { UpdateChecker, updateChecksAllowed } from "./application/update-check.ts";
import { systemAppCatalog } from "./infrastructure/apps/app-catalog.ts";
import { createDetachedLauncher } from "./infrastructure/apps/detached-launcher.ts";
import {
  JsonCustomAppStore,
  JsonRouteProjectStore,
  openWithPathFor,
  routeProjectsPathFor,
} from "./infrastructure/apps/json-stores.ts";
import {
  autoNamedPathFor,
  JsonAutoNamedStore,
} from "./infrastructure/config/json-auto-named-store.ts";
import { defaultConfigPath, JsonConfigStore } from "./infrastructure/config/json-config-store.ts";
import {
  JsonTerminalHistoryStore,
  terminalHistoryPathFor,
} from "./infrastructure/config/json-terminal-history-store.ts";
import { JsonUpdateCache, updateCheckPathFor } from "./infrastructure/config/json-update-cache.ts";
import {
  type ProxyStartRecord,
  proxyStartRecordPathFor,
  readProxyStartRecord,
  recordProxyStarts,
} from "./infrastructure/config/proxy-start-record.ts";
import { installSelfUpdate } from "./infrastructure/npm/self-update.ts";
import { PortlessRegistry } from "./infrastructure/portless/portless-registry.ts";
import { inspectRoutesFile, resolveStateDir } from "./infrastructure/portless/state-files.ts";
import { DockerContainers } from "./infrastructure/system/docker-containers.ts";
import {
  collectDoctorFacts,
  proxyPidsAmong,
  reachesPortless,
  testBind,
} from "./infrastructure/system/doctor-facts.ts";
import { ephemeralRangeReader } from "./infrastructure/system/ephemeral-ports.ts";
import { FaviconFetcher } from "./infrastructure/system/favicon-fetcher.ts";
import { fetchLatestVersion } from "./infrastructure/system/npm-registry.ts";
import { OsNotifier } from "./infrastructure/system/os-notifier.ts";
import { portClosed } from "./infrastructure/system/port-closed.ts";
import { startForwarder } from "./infrastructure/system/port-forwarder.ts";
import { ProjectInfoReader } from "./infrastructure/system/project-info.ts";
import { nodeSystemIo } from "./infrastructure/system/system-io.ts";
import {
  createPortScanner,
  listPortsFor,
  probeHttpResponse,
} from "./infrastructure/system/system-port-scanner.ts";
import { SystemProcessControl } from "./infrastructure/system/system-process-control.ts";
import { systemProcessTree } from "./infrastructure/terminal/process-tree.ts";
import {
  createTerminalSpawner,
  detectTerminalMode,
  interactiveShellName,
  nodeTerminalFolders,
} from "./infrastructure/terminal/terminal-spawner.ts";
import { createHttpServer } from "./interface/http/http-server.ts";

export { defaultConfigPath } from "./infrastructure/config/json-config-store.ts";

/** Only this machine can connect; see docs/architecture.md, Security. */
const LOOPBACK = "127.0.0.1";

/** The adapters Studio runs on, shared by the server and the `init` command. */
export type StudioServices = {
  registry: RouteRegistry;
  scanner: PortScanner;
  configStore: ConfigStore;
  /** One scan with the current config, same filtering as the UI. */
  detectPorts(): Promise<DetectedPort[]>;
  /** Health checks and the fixes Studio can run itself. */
  doctor: DoctorService;
  controlProxy(action: ProxyAction): Promise<Result<string, AppError>>;
  stopProcess(pid: string, all?: boolean): Promise<Result<{ pid: number; port: number }, AppError>>;
  /** Stops a Docker container the last `docker ps` listed. */
  stopContainer(name: string): Promise<Result<{ name: string }, AppError>>;
  /** Restart and stop for Studio itself, when the CLI provides them. */
  studioService?: StudioServiceControl | undefined;
  /** Opens project folders in editors and the file manager. */
  openWith?: OpenWith | undefined;
  /** The terminals Studio runs; they end when Studio stops. */
  terminals?: TerminalManager | undefined;
  /** Opens a link in the browser; the CLI provides it. */
  openUrl?: ((url: string) => void) | undefined;
  /** Whether a newer release is on npm; only when the CLI passes the running version. */
  updates?: UpdateChecker | undefined;
  /** Studio's port-80 forwarder; it listens only once the server runs. */
  shortUrls?: ShortUrls | undefined;
};

export type StudioServicesOptions = {
  /** Portless state directory; defaults to `PORTLESS_STATE_DIR` or `~/.portless`. */
  stateDir?: string | undefined;
  /** Portless binary used for writes; defaults to `PORTLESS_BIN` or `portless` on PATH. */
  portlessBin?: string | undefined;
  /** npm used to install portless; defaults to `npm` on PATH. */
  npmBin?: string | undefined;
  /** Config file; defaults to `defaultConfigPath()`. */
  configPath?: string | undefined;
  /** Studio's own port, left out of detected ports. */
  studioPort?: number | undefined;
  /** Restart and stop for Studio itself; the doctor also reads the login service from it. */
  studioService?: StudioServiceControl | undefined;
  /** Opens a link in the default browser, for focus requests no open page answers. */
  openUrl?: ((url: string) => void) | undefined;
  /**
   * The running version. With it, Studio asks npm at most once a day for a newer one, unless the
   * config, `PORTLESS_STUDIO_NO_UPDATE_CHECK=1`, CI or a test run turns that off.
   */
  version?: string | undefined;
  /**
   * Port short URLs listen on; 80 unless `PORTLESS_STUDIO_SHORT_URL_PORT` says otherwise, which
   * lets a test run without binding port 80.
   */
  shortUrlPort?: number | undefined;
};

/** `PORTLESS_STUDIO_SHORT_URL_PORT`, when it is a valid port; port 80 otherwise. */
export function shortUrlPortFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.PORTLESS_STUDIO_SHORT_URL_PORT;
  const port = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : SHORT_URL_PORT;
}

// Lets startServer reuse the runtime behind services built here, so both share one scan cache.
const runtimes = new WeakMap<StudioServices, StudioRuntime>();

export function createStudioServices(options: StudioServicesOptions = {}): StudioServices {
  const stateDir = options.stateDir ?? resolveStateDir();
  const configPath = options.configPath ?? defaultConfigPath();
  const portless = new PortlessRegistry({
    stateDir,
    bin: options.portlessBin ?? (process.env.PORTLESS_BIN || "portless"),
    ...(options.npmBin === undefined ? {} : { npmBin: options.npmBin }),
  });
  const scanner = createPortScanner();
  const proxyPids = (pids: number[]) => proxyPidsAmong(process.platform, nodeSystemIo, pids);
  const shortUrls = new ShortUrls({
    forwarding: { listen: (port, target) => startForwarder({ port, targetPort: target }) },
    port: options.shortUrlPort ?? shortUrlPortFrom(process.env),
    log: (line) => console.log(line),
    reachesProxy: (port) => reachesPortless(port),
  });
  // A start counts only once the proxy listens, and every proxy Studio starts is written down,
  // so `uninstall` stops only Studio's own. Route URLs drop the port while Studio forwards it.
  const registry = publicUrls(
    recordProxyStarts(
      confirmProxyStarts(portless, { scan: () => scanner.scan(), proxyPids }),
      proxyStartRecordPathFor(configPath),
    ),
    () => shortUrls.publicPort(),
  );
  const configStore = new JsonConfigStore(configPath);
  const notifier = new OsNotifier({ platform: process.platform });
  const containers = new DockerContainers();
  const runtime = new StudioRuntime({
    registry,
    scanner,
    configStore,
    projects: new ProjectInfoReader(),
    studioPort: options.studioPort ?? null,
    probe: (port) => probeHttpResponse(port),
    proxyPids,
    autoNamedStore: new JsonAutoNamedStore(autoNamedPathFor(configPath)),
    notifier,
    icons: new FaviconFetcher(),
    routeProjectStore: new JsonRouteProjectStore(routeProjectsPathFor(configPath)),
    containers,
    shortUrls,
    ephemeralRange: ephemeralRangeReader(process.platform, nodeSystemIo),
  });
  const openWith = new OpenWith({
    catalog: systemAppCatalog(),
    launcher: createDetachedLauncher({ platform: process.platform }),
    customApps: new JsonCustomAppStore(openWithPathFor(configPath)),
    openableFolders: () => runtime.openableFolders(),
  });
  const terminals = new TerminalManager({
    spawner: lazySpawner(),
    folders: nodeTerminalFolders(),
    processTree: systemProcessTree(),
    homeDir: os.homedir(),
    history: new JsonTerminalHistoryStore(terminalHistoryPathFor(configPath)),
    workspace: {
      openableFolders: () => runtime.openableFolders(),
      snapshot: () => runtime.readSnapshot(),
      watch: (onChange) => runtime.watch(onChange),
      createAlias: (name, port) => createAlias(registry, { name, port }),
      renameAlias: (from, to) => renameAlias(registry, from, { name: to }),
    },
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const processes = new SystemProcessControl({
    platform: process.platform,
    io: nodeSystemIo,
    uid,
    userName: os.userInfo().username,
  });
  const proxy = (action: ProxyAction) =>
    controlProxy(action, { registry, processes, config: () => runtime.settings() });
  const studioService = options.studioService;
  const doctor = createDoctorService({
    collect: () =>
      collectDoctorFacts({
        platform: process.platform,
        homeDir: os.homedir(),
        stateDir,
        uid,
        registry,
        configStore,
        processes,
        io: nodeSystemIo,
        listPorts: listPortsFor(process.platform, nodeSystemIo),
        probe: (port) => probeHttpResponse(port),
        ...(studioService ? { loginService: () => studioService.status() } : {}),
        systemNotifier: () => notifier.availability(),
        routesFile: () => inspectRoutesFile(stateDir),
        docker: () => containers.read(),
        lowPort: testBind,
        shortUrls: (config) => shortUrls.inspect(config),
      }),
    controlProxy: proxy,
    updateConfig: (config) => runtime.updateConfig(config),
    syncShortUrls: (config) => shortUrls.sync(config),
  });
  const version = options.version;
  const updates =
    version === undefined
      ? undefined
      : new UpdateChecker({
          current: version,
          enabled: async () =>
            updateChecksAllowed(process.env) && (await runtime.settings()).checkForUpdates,
          fetchLatest: () => fetchLatestVersion(),
          cache: new JsonUpdateCache(updateCheckPathFor(configPath)),
          install: () => installSelfUpdate(options.npmBin ?? "npm"),
        });
  const services: StudioServices = {
    registry,
    scanner,
    configStore,
    detectPorts: () => runtime.detectPorts(),
    doctor,
    controlProxy: proxy,
    stopProcess: (pid, all) =>
      stopProcess(
        pid,
        {
          processes,
          stoppablePids: () => runtime.stoppablePids(),
          selfPid: process.pid,
          listeners: () => scanner.scan(),
          portClosed,
          refresh: () => runtime.refreshProcesses(),
        },
        all,
      ),
    stopContainer: (name) => stopContainer(name, containers),
    studioService,
    openWith,
    terminals,
    openUrl: options.openUrl,
    updates,
    shortUrls,
  };
  runtimes.set(services, runtime);
  return services;
}

/** What `uninstall` needs besides the registry: Studio's own files and who runs a process. */
export type UninstallServices = {
  configDir: string;
  configExists: boolean;
  /** File names in `configDir` that Studio writes. */
  studioFiles: string[];
  autoNamed: AutoNamedStore;
  proxyRecord: ProxyStartRecord | null;
  forgetProxyRecord: () => void;
  ownerOf: (pid: number) => Promise<ProcessOwner>;
};

export function createUninstallServices(configPath = defaultConfigPath()): UninstallServices {
  const autoNamedPath = autoNamedPathFor(configPath);
  const recordPath = proxyStartRecordPathFor(configPath);
  const studioPaths = [
    configPath,
    autoNamedPath,
    recordPath,
    routeProjectsPathFor(configPath),
    openWithPathFor(configPath),
    updateCheckPathFor(configPath),
    terminalHistoryPathFor(configPath),
  ];
  const processes = new SystemProcessControl({
    platform: process.platform,
    io: nodeSystemIo,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    userName: os.userInfo().username,
  });
  return {
    configDir: path.dirname(configPath),
    configExists: studioPaths.some((file) => fs.existsSync(file)),
    studioFiles: studioPaths.map((file) => path.basename(file)),
    autoNamed: new JsonAutoNamedStore(autoNamedPath),
    proxyRecord: readProxyStartRecord(recordPath),
    forgetProxyRecord: () => fs.rmSync(recordPath, { force: true }),
    ownerOf: (pid) => processes.ownerOf(pid),
  };
}

export type ServerOptions = {
  /** 0 picks a free port. */
  port: number;
  /** Portless state directory; defaults to `PORTLESS_STATE_DIR` or `~/.portless`. */
  stateDir?: string | undefined;
  /** Built web app; omit to serve only the API. */
  webDir?: string | undefined;
  /** Portless binary used for writes; defaults to `PORTLESS_BIN` or `portless` on PATH. */
  portlessBin?: string | undefined;
  /** Config file; defaults to `defaultConfigPath()`. Ignored when `services` is given. */
  configPath?: string | undefined;
  /** Adapters to run on; built from the options above when omitted. */
  services?: StudioServices | undefined;
};

export type RunningServer = {
  url: string;
  port: number;
  token: string;
  registry: RouteRegistry;
  services: StudioServices;
  close(): Promise<void>;
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const services =
    options.services ??
    createStudioServices({
      stateDir: options.stateDir,
      portlessBin: options.portlessBin,
      configPath: options.configPath,
    });
  const studio =
    runtimes.get(services) ??
    new StudioRuntime({
      registry: services.registry,
      scanner: services.scanner,
      configStore: services.configStore,
      projects: new ProjectInfoReader(),
      ...(services.shortUrls ? { shortUrls: services.shortUrls } : {}),
    });
  const token = randomBytes(32).toString("base64url");
  const http = createHttpServer({
    registry: services.registry,
    studio,
    token,
    webDir: options.webDir,
    doctor: services.doctor,
    controlProxy: services.controlProxy,
    stopProcess: services.stopProcess,
    stopContainer: services.stopContainer,
    ...(services.studioService ? { studioService: services.studioService } : {}),
    ...(services.openWith ? { openWith: services.openWith } : {}),
    ...(services.terminals ? { terminals: services.terminals } : {}),
    ...(services.openUrl ? { openUrl: services.openUrl } : {}),
    ...(services.updates ? { updates: services.updates } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(options.port, LOOPBACK, () => {
      http.server.off("error", reject);
      resolve();
    });
  });
  const { port } = http.server.address() as AddressInfo;
  studio.setStudioPort(port);
  studio.start();
  // The short-URL forwarder settles before anyone prints or registers a URL.
  await studio.ready();
  // Terminals that were running when Studio stopped; never holds up the start.
  void studio
    .settings()
    .then((config) => services.terminals?.restore(config.restoreTerminals))
    .catch(() => {});

  return {
    url: `http://${LOOPBACK}:${port}`,
    port,
    token,
    registry: services.registry,
    services,
    close: () =>
      new Promise((resolve) => {
        studio.stop();
        services.terminals?.closeAll();
        http.closeStreams();
        void (services.shortUrls?.close() ?? Promise.resolve()).finally(() => {
          http.server.close(() => resolve());
          http.server.closeAllConnections();
        });
      }),
  };
}

/**
 * Finds out on the first terminal whether `script` can give it a pseudo-terminal, so starting
 * Studio and commands that never open a terminal do not run `script -V`.
 */
function lazySpawner(): TerminalSpawner {
  let real: Promise<TerminalSpawner> | null = null;
  let mode: TerminalSpawner["mode"] = "pipes";
  return {
    get mode() {
      return mode;
    },
    shellName: interactiveShellName(),
    spawn: async (request) => {
      real ??= detectTerminalMode(process.platform).then((detected) =>
        createTerminalSpawner({ mode: detected }),
      );
      const spawner = await real;
      mode = spawner.mode;
      return spawner.spawn(request);
    },
  };
}
