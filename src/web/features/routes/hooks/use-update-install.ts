import { useCallback, useState } from "react";
import { apiErrorMessage } from "./route-messages.ts";
import { useRoutesGateway } from "./routes-gateway-context.tsx";

export type UpdateInstallStatus = "idle" | "installing" | "installed" | "failed";

export type UpdateInstallState = {
  status: UpdateInstallStatus;
  /** The version npm installed, once it has. */
  installedVersion: string | null;
  /** Why the last install failed, including what npm printed. */
  error: string | null;
  install: () => Promise<void>;
};

/** Runs `npm install -g portless-studio` through the gateway and tracks its progress. */
export function useUpdateInstall(): UpdateInstallState {
  const gateway = useRoutesGateway();
  const [status, setStatus] = useState<UpdateInstallStatus>("idle");
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = useCallback(async () => {
    if (!gateway.installUpdate) return;
    setStatus("installing");
    setError(null);
    const result = await gateway.installUpdate();
    if (!result.ok) {
      setStatus("failed");
      setError(apiErrorMessage(result.error));
      return;
    }
    setStatus("installed");
    setInstalledVersion(result.value.version);
  }, [gateway]);

  return { status, installedVersion, error, install };
}
