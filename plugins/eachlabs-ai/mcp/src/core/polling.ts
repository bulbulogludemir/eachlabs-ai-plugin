import { abortableSleep } from "./http.js";

export type ToolExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

export async function pollUntilDone(
  fetchCurrent: () => Promise<Record<string, unknown>>,
  terminalStatuses: string[],
  timeoutSeconds: number,
  pollIntervalSeconds: number,
  extra?: ToolExtra,
): Promise<{
  completed: boolean;
  cancelled?: boolean;
  last?: Record<string, unknown>;
}> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: Record<string, unknown> | undefined;

  while (Date.now() <= deadline) {
    if (extra?.signal?.aborted) {
      return { completed: false, cancelled: true, last };
    }

    last = await fetchCurrent();
    const status = String(last.status ?? "").toLowerCase();
    if (terminalStatuses.includes(status)) {
      return { completed: true, last };
    }

    const progressToken = extra?._meta?.progressToken;
    if (progressToken !== undefined && extra?.sendNotification) {
      const elapsedSeconds = Math.max(
        0,
        Math.round(timeoutSeconds - (deadline - Date.now()) / 1000),
      );
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: elapsedSeconds,
            total: timeoutSeconds,
            message: status,
          },
        })
        .catch(() => undefined);
    }

    try {
      await abortableSleep(
        Math.min(pollIntervalSeconds * 1000, Math.max(0, deadline - Date.now())),
        extra?.signal,
      );
    } catch {
      return { completed: false, cancelled: true, last };
    }
  }

  return { completed: false, last };
}
