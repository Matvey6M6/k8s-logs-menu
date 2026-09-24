export const SERVICE_LOGS_PAGE_ID = "service-logs";

export const Channels = {
  detectKubectl: "service-logs:detect-kubectl",
  listClusters: "service-logs:list-clusters",
  probeClusters: "service-logs:probe-clusters",
  listNamespaces: "service-logs:list-namespaces",
  listWorkloads: "service-logs:list-workloads",
  resolveTargets: "service-logs:resolve-targets",
  chooseOutput: "service-logs:choose-output",
  collect: "service-logs:collect",
  cancel: "service-logs:cancel",
  revealOutput: "service-logs:reveal-output",
  
  progress: "service-logs:progress",
} as const;

export interface ClusterInfo {
  id: string;
  name: string;
  kubeconfigPath: string;
  context: string;
  source?: string;
  accessibleNamespaces?: string[];
}

export type ClusterProbeState = "checking" | "ok" | "denied" | "offline" | "error";

export interface ClusterProbe {
  state: ClusterProbeState;
  
  version?: string;
  
  message?: string;
}

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Pod";

export interface WorkloadInfo {
  clusterId: string;
  clusterName: string;
  namespace: string;
  kind: WorkloadKind;
  name: string;
  
  selector: string;
  replicas?: number;
  readyReplicas?: number;
  containers: string[];
  initContainers: string[];
  
  defaultContainer?: string;
}

export interface PodTargetContainer {
  name: string;
  
  reason: string;
  init: boolean;
}

export interface PodTarget {
  clusterId: string;
  clusterName: string;
  namespace: string;
  pod: string;
  workload: string;
  workloadKind: WorkloadKind;
  phase: string;
  containers: PodTargetContainer[];
  skipped: PodTargetContainer[];
  restartCounts: Record<string, number>;
}

export interface LogOptions {
  timestamps: boolean;
  
  sinceSeconds: number;
  
  previous: boolean;
  
  limitBytes: number;
}

export type OutputFormat = "zip" | "folder" | "single";

export interface WorkloadSelection {
  clusterId: string;
  namespace: string;
  kind: WorkloadKind;
  name: string;
  selector: string;
}

export interface CollectRequest {
  requestId: string;
  kubectlPath?: string;
  workloads: WorkloadSelection[];
  logs: LogOptions;
  output: {
    format: OutputFormat;
    
    path: string;
  };
  concurrency: number;
}

export interface CollectedEntry {
  clusterId: string;
  cluster: string;
  namespace: string;
  workload: string;
  pod: string;
  container: string;
  previous: boolean;
  path: string;
  bytes: number;
  error?: string;
}

export interface CollectResult {
  outputPath: string;
  format: OutputFormat;
  entries: CollectedEntry[];
  failures: CollectedEntry[];
  warnings: string[];
  totalBytes: number;
  cancelled: boolean;
}

export interface ProgressEvent {
  requestId: string;
  phase: "resolving" | "downloading" | "packaging" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  message: string;
}

export interface ResolveTargetsRequest {
  kubectlPath?: string;
  workloads: WorkloadSelection[];
}

export interface WorkloadListing {
  workloads: WorkloadInfo[];
  
  warnings: string[];
}

export interface NamespaceListing {
  namespaces: string[];
  warnings: string[];
}

export interface KubectlInfo {
  path?: string;
  version?: string;
  error?: string;
  searched: string[];
}
