import { Renderer } from "@k8slens/extensions";
import { SERVICE_LOGS_PAGE_ID } from "../common/types";

export class ServiceLogsIpcRenderer extends Renderer.Ipc {}

interface SingletonOf<T> {
  createInstance(extension: Renderer.LensExtension): T;
  getInstance(strict: false): T | undefined;
}

const singleton = ServiceLogsIpcRenderer as unknown as SingletonOf<ServiceLogsIpcRenderer>;

let extensionRef: Renderer.LensExtension | undefined;

export function registerServiceLogsIpc(extension: Renderer.LensExtension): ServiceLogsIpcRenderer {
  extensionRef = extension;

  return singleton.createInstance(extension);
}

export function serviceLogsIpc(): ServiceLogsIpcRenderer {
  const existing = singleton.getInstance(false);

  if (existing) return existing;

  if (!extensionRef) {
    throw new Error("the service logs IPC is not ready yet");
  }

  return registerServiceLogsIpc(extensionRef);
}

export async function navigateToServiceLogs(params?: Record<string, string>): Promise<void> {
  await extensionRef?.navigate(SERVICE_LOGS_PAGE_ID, params);
}
