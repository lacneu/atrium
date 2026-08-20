import type { InstanceData } from "../config.js";

export interface RegistrationDiscoveryDeps {
  data: InstanceData;
  discover: (data: InstanceData) => Promise<unknown>;
  intervalMs: number;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RegistrationDiscovery {
  stop: () => void;
}

const defaultSetTimer = (
  fn: () => void,
  ms: number,
): ReturnType<typeof setTimeout> => {
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
};

/** Retry the first OpenClaw discovery until the newly approved device connects. */
export function startRegistrationDiscovery(
  deps: RegistrationDiscoveryDeps,
): RegistrationDiscovery {
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let waitingReported = false;

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    try {
      await deps.discover(deps.data);
      if (!stopped) {
        deps.log?.(
          `initial discovery for "${deps.data.instanceName}" is connected`,
        );
      }
    } catch {
      if (stopped) return;
      if (!waitingReported) {
        waitingReported = true;
        deps.log?.(
          `initial discovery for "${deps.data.instanceName}" awaits pairing; retrying in the background`,
        );
      }
      timer = setTimer(() => {
        timer = null;
        void attempt();
      }, deps.intervalMs);
    }
  };

  void attempt();
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
