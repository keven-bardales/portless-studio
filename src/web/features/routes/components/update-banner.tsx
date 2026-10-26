import { Button } from "../../../shared/ui/button.tsx";
import { Icon } from "../../../shared/ui/icons/icon.tsx";
import { Spinner } from "../../../shared/ui/spinner.tsx";
import type { UpdateInstallStatus } from "../hooks/use-update-install.ts";
import { CopyCommand } from "./copy-command.tsx";
import styles from "./update-banner.module.css";

type UpdateBannerProps = {
  current: string;
  latest: string;
  command: string;
  /** Present only when the server can run the update itself. */
  canInstall: boolean;
  installStatus: UpdateInstallStatus;
  installError: string | null;
  installedVersion: string | null;
  restarting: boolean;
  onInstall: () => void;
  onCopyCommand: (command: string) => void;
  onRestart: () => void;
  onDismiss: () => void;
};

/**
 * Says a newer portless-studio is on npm. Update now runs it on the server and offers a restart;
 * the command is always there too, for whoever would rather run it themselves. Hidden once
 * dismissed, until a newer version comes out.
 */
export function UpdateBanner({
  current,
  latest,
  command,
  canInstall,
  installStatus,
  installError,
  installedVersion,
  restarting,
  onInstall,
  onCopyCommand,
  onRestart,
  onDismiss,
}: UpdateBannerProps) {
  const installing = installStatus === "installing";
  const installed = installStatus === "installed";

  return (
    <section className={styles.banner} aria-labelledby="update-banner-title" role="status">
      <div className={styles.header}>
        <span className={styles.icon}>
          <Icon name="zap" size={16} />
        </span>
        <div className={styles.intro}>
          <h2 id="update-banner-title" className={styles.title}>
            portless-studio {latest} is available
          </h2>
          <p className={styles.text}>You run {current}.</p>
        </div>
      </div>

      {installed ? (
        <div className={styles.actions}>
          <p className={styles.text}>Updated to {installedVersion}. Restart Studio to use it.</p>
          <div className={styles.restartActions}>
            <Button
              size="sm"
              variant="primary"
              onClick={onRestart}
              disabled={restarting}
              aria-busy={restarting}
            >
              {restarting ? <Spinner /> : null}
              {restarting ? "Restarting…" : "Restart now"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              I'll restart later
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          {canInstall ? (
            <Button
              variant="primary"
              size="sm"
              onClick={onInstall}
              disabled={installing}
              aria-busy={installing}
            >
              {installing ? <Spinner /> : <Icon name="terminal" size={14} />}
              {installing ? "Installing…" : "Update now"}
            </Button>
          ) : null}
          <div className={styles.command}>
            <CopyCommand
              command={command}
              description={canInstall ? "Or run it yourself" : "Update with"}
              onCopy={onCopyCommand}
            />
          </div>
          <Button
            size="xs"
            variant="ghost"
            iconOnly
            aria-label="Dismiss the update notice"
            disabled={installing}
            onClick={onDismiss}
          >
            <Icon name="x" size={14} />
          </Button>
        </div>
      )}

      {installing ? (
        <p className={styles.hint} role="status">
          Running {command}. This can take a minute.
        </p>
      ) : null}

      {installStatus === "failed" && installError ? (
        <div className={styles.error} role="alert">
          <strong className={styles.errorTitle}>The update failed.</strong>
          <pre className={styles.log}>{installError}</pre>
          <span className={styles.errorHint}>
            If npm needs more permissions, run the command above in a terminal.
          </span>
        </div>
      ) : null}
    </section>
  );
}
