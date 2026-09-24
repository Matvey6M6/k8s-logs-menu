import type { PodTargetContainer } from "./types";

export const LOG_CONTAINER_ANNOTATIONS = [
  "kubectl.kubernetes.io/default-logs-container",
  "default-logs-container",
  "kubectl.kubernetes.io/default-container",
  "default-container",
];

export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (!escaped) return false;

  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function workloadNameFromPod(podName: string): string {
  return podName
    .replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, "") 
    .replace(/-[0-9]+$/, "") 
    .replace(/-[a-z0-9]{5}$/, ""); 
}

export function annotatedContainer(
  annotations: Record<string, string> | undefined,
  containers: string[],
): { name: string; annotation: string } | undefined {
  if (!annotations) return undefined;

  for (const annotation of LOG_CONTAINER_ANNOTATIONS) {
    const name = annotations[annotation];

    if (name && containers.includes(name)) {
      return { name, annotation };
    }
  }

  return undefined;
}

export interface PodLike {
  name: string;
  workload?: string;
  containers: string[];
  annotations?: Record<string, string>;
}

export interface ContainerPick {
  selected: PodTargetContainer[];
  skipped: PodTargetContainer[];
}

export function pickContainers(pod: PodLike): ContainerPick {
  const annotated = annotatedContainer(pod.annotations, pod.containers);
  const chosen = annotated?.name ?? pod.containers[0];
  const reason = annotated
    ? `по аннотации ${annotated.annotation}`
    : pod.containers.length > 1
      ? "нет аннотации default-logs-container — взят первый контейнер"
      : "единственный контейнер";

  const selected: PodTargetContainer[] = [];
  const skipped: PodTargetContainer[] = [];

  for (const name of pod.containers) {
    if (name === chosen) {
      selected.push({ name, init: false, reason });
    } else {
      skipped.push({ name, init: false, reason: "не указан в аннотации default-logs-container" });
    }
  }

  return { selected, skipped };
}
