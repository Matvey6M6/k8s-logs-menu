export const WINDOWS_PATH_LIMIT = 260;

export const ARCHIVE_PATH_BUDGET = 150;

export function sanitizeSegment(segment: string): string {
  return (segment || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export function shortHash(value: string): string {
  let hash = 5381;

  for (let i = 0; i < value.length; i++) {
    hash = (((hash << 5) + hash) ^ value.charCodeAt(i)) >>> 0;
  }

  return hash.toString(36).slice(0, 6);
}

function truncate(value: string, length: number, seed: string): string {
  if (value.length <= length) return value;

  return `${value.slice(0, Math.max(1, length - 7))}-${shortHash(seed)}`;
}

export interface EntryPathInput {
  cluster: string;
  namespace: string;
  workload: string;
  pod: string;
  container: string;
  previous: boolean;
}

export interface EntryPath {
  path: string;

  shortened: boolean;
}

export function buildEntryPath(input: EntryPathInput, budget = ARCHIVE_PATH_BUDGET): EntryPath {
  const cluster = sanitizeSegment(input.cluster);
  const namespace = sanitizeSegment(input.namespace);
  const workload = sanitizeSegment(input.workload);
  const pod = sanitizeSegment(input.pod);
  const container = sanitizeSegment(input.container);
  const suffix = `${input.previous ? ".previous" : ""}.log`;
  const seed = `${cluster}/${namespace}/${workload}/${pod}/${container}${suffix}`;

  const podShort = pod.startsWith(`${workload}-`) && pod.length > workload.length + 1
    ? pod.slice(workload.length + 1)
    : pod;

  const containerPart = container === workload || container === pod ? "" : `__${container}`;

  const variants: string[] = [
    `${cluster}/${namespace}/${workload}/${pod}${containerPart}${suffix}`,
    `${cluster}/${namespace}/${workload}/${pod}${suffix}`,
    `${cluster}/${namespace}/${workload}/${podShort}${suffix}`,
    `${cluster}/${namespace}/${truncate(workload, 24, seed)}/${podShort}${suffix}`,
    `${cluster}/${truncate(namespace, 24, seed)}/${truncate(workload, 16, seed)}/${podShort}${suffix}`,
    `${cluster}/${truncate(podShort, 24, seed)}-${shortHash(seed)}${suffix}`,
  ];

  for (const [index, variant] of variants.entries()) {
    if (variant.length <= budget) {
      return { path: variant, shortened: index > 1 };
    }
  }

  return { path: `${shortHash(seed)}${suffix}`, shortened: true };
}

export function pathBudget(format: string, destination: string): number {
  if (format !== "folder") return ARCHIVE_PATH_BUDGET;

  return Math.max(60, WINDOWS_PATH_LIMIT - 10 - destination.length);
}
