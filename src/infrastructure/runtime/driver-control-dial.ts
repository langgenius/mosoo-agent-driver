import type { DriverBootPayload } from "../../protocol/boot";
import { createPromiseDeferred, settlePromiseWithTimeout, sleepPromise } from "../../utils/async";

export type DriverWireSocket = Pick<
  WebSocket,
  "addEventListener" | "close" | "readyState" | "removeEventListener" | "send"
>;

const DRIVER_CONTROL_DIAL_DEADLINE_MS = 30_000;
const DRIVER_CONTROL_DIAL_ATTEMPT_TIMEOUT_MS = 5_000;
const DRIVER_CONTROL_DIAL_RETRY_MS = 1_000;

function toDriverControlSocketUrl(payload: DriverBootPayload): URL {
  const url = new URL(payload.controlUrl);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Driver control URL protocol is not supported: ${url.protocol}`);
  }

  url.searchParams.set("driverInstanceId", payload.driverInstanceId);
  url.searchParams.set("token", payload.bootToken);
  url.searchParams.set("traceparent", payload.traceparent);
  return url;
}

async function dialOnce(url: URL): Promise<WebSocket> {
  const opened = createPromiseDeferred<WebSocket>();
  const socket = new WebSocket(url);

  socket.addEventListener(
    "open",
    () => {
      opened.resolve(socket);
    },
    { once: true },
  );
  socket.addEventListener(
    "close",
    (event) => {
      opened.reject(
        new Error(
          `Driver control socket closed before open: ${event.reason || String(event.code)}`,
        ),
      );
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    () => {
      opened.reject(new Error("Driver control socket connection failed."));
    },
    { once: true },
  );

  const result = await settlePromiseWithTimeout(opened.promise, {
    label: "runtime driver control socket dial",
    timeoutMs: DRIVER_CONTROL_DIAL_ATTEMPT_TIMEOUT_MS,
  });

  if (result.status === "completed") {
    return result.value;
  }

  socket.close(1000, "runtime.dial.abandoned");
  throw result.error;
}

export async function dialDriverControlSocket(
  payload: DriverBootPayload,
): Promise<DriverWireSocket> {
  const url = toDriverControlSocketUrl(payload);
  const deadlineMs = Date.now() + DRIVER_CONTROL_DIAL_DEADLINE_MS;
  let lastError: unknown = null;

  while (true) {
    try {
      return await dialOnce(url);
    } catch (error) {
      lastError = error;
    }

    if (Date.now() + DRIVER_CONTROL_DIAL_RETRY_MS >= deadlineMs) {
      break;
    }

    await sleepPromise(DRIVER_CONTROL_DIAL_RETRY_MS);
  }

  throw lastError instanceof Error ? lastError : new Error("Driver control socket dial timed out.");
}
