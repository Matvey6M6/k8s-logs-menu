import type { ClusterInfo, ClusterProbe } from "../common/types";
import { execFor } from "./k8s";
import type { Kubectl } from "./kubectl";

const DENIED = /unauthorized|forbidden|401|403|credential|invalid bearer|certificate signed|x509/i;
const OFFLINE = /timed? ?out|timeout|connection refused|no such host|dial tcp|unreachable|network is|tls handshake|etimedout|econnreset|killed/i;

function classify(message: string): ClusterProbe {
  if (DENIED.test(message)) return { state: "denied", message };
  if (OFFLINE.test(message)) return { state: "offline", message };

  return { state: "error", message };
}

export async function probeCluster(kubectl: Kubectl, cluster: ClusterInfo): Promise<ClusterProbe> {
  try {
    const raw = await kubectl.run(
      ["get", "--raw", "/version", "--request-timeout=5s"],
      execFor(cluster, 15_000),
    );
    const parsed = JSON.parse(raw) as { gitVersion?: string; major?: string; minor?: string };

    return {
      state: "ok",
      version: parsed.gitVersion || [parsed.major, parsed.minor].filter(Boolean).join("."),
    };
  } catch (error) {
    return classify(error instanceof Error ? error.message : String(error));
  }
}

export async function probeClusters(
  kubectl: Kubectl,
  clusters: ClusterInfo[],
  concurrency = 6,
): Promise<Record<string, ClusterProbe>> {
  const result: Record<string, ClusterProbe> = {};
  const queue = [...clusters];
  const worker = async () => {
    for (;;) {
      const cluster = queue.shift();

      if (!cluster) return;

      result[cluster.id] = await probeCluster(kubectl, cluster);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, clusters.length || 1)) }, worker));

  return result;
}
