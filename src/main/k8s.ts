import { annotatedContainer } from "../common/containers";
import { pool } from "../common/pool";
import type { ClusterInfo, NamespaceListing, WorkloadInfo, WorkloadKind, WorkloadListing } from "../common/types";
import type { ExecOptions, Kubectl } from "./kubectl";

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

interface PodSpecLike {
  containers?: { name: string }[];
  initContainers?: { name: string }[];
}

interface KubeList<T> {
  items?: T[];
}

interface WorkloadObject {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    selector?: LabelSelector;
    replicas?: number;
    template?: {
      metadata?: { annotations?: Record<string, string>; labels?: Record<string, string> };
      spec?: PodSpecLike;
    };
  };
  status?: { replicas?: number; readyReplicas?: number; numberReady?: number; desiredNumberScheduled?: number };
}

export interface PodObject {
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    ownerReferences?: { kind?: string; name?: string }[];
  };
  spec?: PodSpecLike;
  status?: {
    phase?: string;
    containerStatuses?: { name: string; restartCount?: number }[];
    initContainerStatuses?: { name: string; restartCount?: number }[];
  };
}

export function execFor(cluster: ClusterInfo, timeoutMs?: number): ExecOptions {
  return {
    kubeconfig: cluster.kubeconfigPath,
    context: cluster.context,
    timeoutMs,
  };
}

export function serializeSelector(selector?: LabelSelector): string {
  if (!selector) return "";

  const parts: string[] = [];

  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    parts.push(`${key}=${value}`);
  }

  for (const expression of selector.matchExpressions ?? []) {
    const values = (expression.values ?? []).join(",");

    switch (expression.operator) {
    case "In":
      parts.push(`${expression.key} in (${values})`);
      break;
    case "NotIn":
      parts.push(`${expression.key} notin (${values})`);
      break;
    case "Exists":
      parts.push(expression.key);
      break;
    case "DoesNotExist":
      parts.push(`!${expression.key}`);
      break;
    default:
      break;
    }
  }

  return parts.join(",");
}

export async function listNamespaces(kubectl: Kubectl, cluster: ClusterInfo): Promise<NamespaceListing> {
  const { data, warnings } = await kubectl.jsonTolerant<KubeList<{ metadata?: { name?: string } }>>(
    ["get", "namespaces"],
    execFor(cluster, 45_000),
  );

  return {
    namespaces: (data?.items ?? [])
      .map(item => item.metadata?.name)
      .filter((name): name is string => Boolean(name))
      .sort(),
    warnings: warnings.map(warning => `${cluster.name}: ${warning}`),
  };
}

const WORKLOAD_KINDS: Record<string, WorkloadKind> = {
  Deployment: "Deployment",
  StatefulSet: "StatefulSet",
  DaemonSet: "DaemonSet",
};

function toWorkload(cluster: ClusterInfo, object: WorkloadObject): WorkloadInfo | undefined {
  const kind = WORKLOAD_KINDS[object.kind ?? ""];
  const name = object.metadata?.name;
  const namespace = object.metadata?.namespace;

  if (!kind || !name || !namespace) return undefined;

  const template = object.spec?.template;
  const containers = (template?.spec?.containers ?? []).map(container => container.name);

  return {
    clusterId: cluster.id,
    clusterName: cluster.name,
    namespace,
    kind,
    name,
    selector: serializeSelector(object.spec?.selector),
    replicas: object.spec?.replicas ?? object.status?.desiredNumberScheduled ?? object.status?.replicas,
    readyReplicas: object.status?.readyReplicas ?? object.status?.numberReady,
    containers,
    initContainers: (template?.spec?.initContainers ?? []).map(container => container.name),
    defaultContainer: annotatedContainer(template?.metadata?.annotations, containers)?.name,
  };
}

export async function listWorkloads(
  kubectl: Kubectl,
  cluster: ClusterInfo,
  namespaces: string[],
  concurrency = 6,
): Promise<WorkloadListing> {
  const resources = ["deployments.apps", "statefulsets.apps", "daemonsets.apps"].join(",");

  const gather = async (args: string[], scope: string) => {
    const { data, warnings } = await kubectl.jsonTolerant<KubeList<WorkloadObject>>(
      ["get", resources, ...args],
      execFor(cluster, 120_000),
    );
    const found: WorkloadInfo[] = [];

    for (const item of data?.items ?? []) {
      const workload = toWorkload(cluster, item);

      if (workload) found.push(workload);
    }

    return { found, problems: warnings.map(problem => `${cluster.name}${scope}: ${problem}`) };
  };

  const answers = namespaces.length === 0
    ? [await gather(["--all-namespaces"], "")]
    : await pool(namespaces, concurrency, namespace => gather(["-n", namespace], `/${namespace}`));

  const collected: WorkloadInfo[] = [];
  const warnings = new Set<string>();

  for (const answer of answers) {
    collected.push(...answer.found);

    for (const problem of answer.problems) warnings.add(problem);
  }

  const wanted = new Set(namespaces);
  const workloads = (namespaces.length === 0
    ? collected
    : collected.filter(workload => wanted.has(workload.namespace)))
    .sort(sortWorkloads);

  return { workloads, warnings: [...warnings] };
}

function sortWorkloads(a: WorkloadInfo, b: WorkloadInfo): number {
  return a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);
}

export async function listPods(
  kubectl: Kubectl,
  cluster: ClusterInfo,
  namespace: string,
  selector: string,
): Promise<{ pods: PodObject[]; warnings: string[] }> {
  const args = ["get", "pods", "-n", namespace];

  if (selector) args.push("-l", selector);

  const { data, warnings } = await kubectl.jsonTolerant<KubeList<PodObject>>(args, execFor(cluster, 90_000));

  return {
    pods: (data?.items ?? []).filter(pod => Boolean(pod.metadata?.name)),
    warnings,
  };
}

export function restartCounts(pod: PodObject): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const status of pod.status?.containerStatuses ?? []) {
    counts[status.name] = status.restartCount ?? 0;
  }

  for (const status of pod.status?.initContainerStatuses ?? []) {
    counts[status.name] = status.restartCount ?? 0;
  }

  return counts;
}
