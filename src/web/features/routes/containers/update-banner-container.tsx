import { UpdateBanner } from "../components/update-banner.tsx";
import { useRoutesGateway } from "../hooks/routes-gateway-context.tsx";
import { useServiceControl } from "../hooks/use-service-control.ts";
import { useUpdateInstall } from "../hooks/use-update-install.ts";
import { useUpdateNotice } from "../hooks/use-update-notice.ts";

/** Shows the update notice when the server knows of a newer release not yet dismissed. */
export function UpdateBannerContainer({
  onCopyCommand,
}: {
  onCopyCommand: (command: string) => void;
}) {
  const { update, dismiss } = useUpdateNotice();
  const { status, installedVersion, error, install } = useUpdateInstall();
  const { studioBusy, controlStudio } = useServiceControl();
  const gateway = useRoutesGateway();

  if (!update?.latest) return null;
  return (
    <UpdateBanner
      current={update.current}
      latest={update.latest}
      command={update.command}
      canInstall={gateway.installUpdate !== undefined}
      installStatus={status}
      installError={error}
      installedVersion={installedVersion}
      restarting={studioBusy === "restart"}
      onInstall={() => void install()}
      onCopyCommand={onCopyCommand}
      onRestart={() => void controlStudio("restart")}
      onDismiss={dismiss}
    />
  );
}
