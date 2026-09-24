import { createReadStream, createWriteStream, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { pickContainers } from "../common/containers";
import { buildEntryPath, pathBudget, sanitizeSegment } from "../common/paths";
import type {
  ClusterInfo,
  CollectRequest,
  CollectResult,
  CollectedEntry,
  PodTarget,
  ProgressEvent,
  ResolveTargetsRequest,
  WorkloadSelection,
} from "../common/types";
import { execFor, listPods, restartCounts } from "./k8s";
import type { PodObject } from "./k8s";
import { Kubectl, KubectlError } from "./kubectl";
import { ZipLimitExceededError, ZipWriter } from "./zip";

export type ProgressReporter = (event: ProgressEvent) => void;

export const sanitize = sanitizeSegment;

interface DownloadJob {
  target: PodTarget;
  container: string;
  previous: boolean;
  relativePath: string;
}

function podTarget(
  cluster: ClusterInfo,
  selection: WorkloadSelection,
  pod: PodObject,
): PodTarget {
  const name = pod.metadata?.name ?? "";
  const pick = pickContainers({
    name,
    workload: selection.name,
    containers: (pod.spec?.containers ?? []).map(container => container.name),
    annotations: pod.metadata?.annotations,
  });

  return {
    clusterId: cluster.id,
    clusterName: cluster.name,
    namespace: selection.namespace,
    pod: name,
    workload: selection.name,
    workloadKind: selection.kind,
    phase: pod.status?.phase ?? "Unknown",
    containers: pick.selected,
    skipped: pick.skipped,
    restartCounts: restartCounts(pod),
  };
}

export class LogCollector {
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly kubectl: Kubectl,
    private readonly clusters: Map<string, ClusterInfo>,
    private readonly report: ProgressReporter,
  ) {}

  cancel(requestId: string): void {
    this.cancelled.add(requestId);
    this.kubectl.killAll();
  }

  async resolveTargets(request: ResolveTargetsRequest): Promise<{ targets: PodTarget[]; warnings: string[] }> {
    const targets: PodTarget[] = [];
    const warnings: string[] = [];

    for (const selection of request.workloads) {
      const cluster = this.clusters.get(selection.clusterId);

      if (!cluster) {
        warnings.push(`кластера ${selection.clusterId} больше нет в каталоге`);
        continue;
      }

      try {
        const { pods, warnings: problems } = await listPods(
          this.kubectl,
          cluster,
          selection.namespace,
          selection.selector,
        );

        for (const problem of problems) {
          warnings.push(`${cluster.name}/${selection.namespace}: ${problem}`);
        }

        if (pods.length === 0) {
          warnings.push(`${cluster.name}/${selection.namespace}/${selection.name}: подходящих подов нет`);
          continue;
        }

        for (const pod of pods) {
          targets.push(podTarget(cluster, selection, pod));
        }
      } catch (error) {
        warnings.push(`${cluster.name}/${selection.namespace}/${selection.name}: ${describeError(error)}`);
      }
    }

    return { targets, warnings };
  }

  async collect(request: CollectRequest): Promise<CollectResult> {
    const { requestId } = request;

    this.cancelled.delete(requestId);
    this.report({ requestId, phase: "resolving", done: 0, total: 0, message: "Ищу поды..." });

    const { targets, warnings } = await this.resolveTargets({
      kubectlPath: request.kubectlPath,
      workloads: request.workloads,
    });

    const jobs: DownloadJob[] = [];

    const budget = pathBudget(request.output.format, request.output.path);
    let shortenedNames = 0;

    for (const target of targets) {
      for (const container of target.containers) {
        const restarts = target.restartCounts[container.name] ?? 0;
        const wanted = request.logs.previous && restarts > 0 ? [false, true] : [false];

        for (const previous of wanted) {
          const entry = buildEntryPath({
            cluster: target.clusterName,
            namespace: target.namespace,
            workload: target.workload,
            pod: target.pod,
            container: container.name,
            previous,
          }, budget);

          if (entry.shortened) shortenedNames += 1;

          jobs.push({
            target,
            container: container.name,
            previous,
            relativePath: entry.path,
          });
        }
      }
    }

    if (shortenedNames > 0) {
      warnings.push(
        `имена ${shortenedNames} файлов укорочены, чтобы путь поместился в ограничение Windows `
        + "(260 символов); полное соответствие пода и файла есть в manifest.json",
      );
    }

    if (jobs.length === 0) {
      return {
        outputPath: request.output.path,
        format: request.output.format,
        entries: [],
        failures: [],
        warnings: [...warnings, "нечего скачивать: не найдено ни одного контейнера"],
        totalBytes: 0,
        cancelled: false,
      };
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openlens-service-logs-"));
    const entries: CollectedEntry[] = [];
    const failures: CollectedEntry[] = [];
    let done = 0;

    this.report({
      requestId,
      phase: "downloading",
      done,
      total: jobs.length,
      message: `Логов контейнеров к скачиванию: ${jobs.length}`,
    });

    const queue = [...jobs];
    const workerCount = Math.max(1, Math.min(request.concurrency || 4, 16));

    const worker = async () => {
      for (;;) {
        const job = queue.shift();

        if (!job || this.cancelled.has(requestId)) return;

        const cluster = this.clusters.get(job.target.clusterId);
        const destination = path.join(workDir, job.relativePath);
        const entry: CollectedEntry = {
          clusterId: job.target.clusterId,
          cluster: job.target.clusterName,
          namespace: job.target.namespace,
          workload: job.target.workload,
          pod: job.target.pod,
          container: job.container,
          previous: job.previous,
          path: job.relativePath,
          bytes: 0,
        };

        try {
          if (!cluster) throw new Error("cluster is gone");

          await fs.mkdir(path.dirname(destination), { recursive: true });

          const { bytes } = await this.kubectl.logsToFile(
            logArgs(job, request),
            destination,
            execFor(cluster, 0),
          );

          entry.bytes = bytes;
          entries.push(entry);
        } catch (error) {
          entry.error = describeError(error);
          failures.push(entry);
        } finally {
          done += 1;
          this.report({
            requestId,
            phase: "downloading",
            done,
            total: jobs.length,
            message: `${job.target.pod} / ${job.container}`,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (this.cancelled.has(requestId)) {
      await fs.rm(workDir, { recursive: true, force: true });
      this.report({ requestId, phase: "cancelled", done, total: jobs.length, message: "Отменено" });

      return {
        outputPath: request.output.path,
        format: request.output.format,
        entries,
        failures,
        warnings,
        totalBytes: 0,
        cancelled: true,
      };
    }

    await fs.writeFile(
      path.join(workDir, "manifest.json"),
      JSON.stringify(buildManifest(request, targets, entries, failures, warnings), null, 2),
      "utf8",
    );

    this.report({ requestId, phase: "packaging", done, total: jobs.length, message: "Упаковываю..." });

    let outputPath = request.output.path;
    let format = request.output.format;

    try {
      if (format === "zip") {
        outputPath = await packZip(workDir, entries, request.output.path);
      } else if (format === "single") {
        outputPath = await mergeIntoSingleFile(workDir, entries, request.output.path, request.logs.timestamps);
      } else {
        outputPath = await copyTree(workDir, request.output.path);
      }
    } catch (error) {
      if (error instanceof ZipLimitExceededError) {
        format = "folder";
        outputPath = await copyTree(workDir, request.output.path.replace(/\.zip$/i, ""));
        warnings.push("архив вышел бы больше 4 ГиБ — логи сохранены папкой");
      } else {
        await fs.rm(workDir, { recursive: true, force: true });
        throw error;
      }
    }

    await fs.rm(workDir, { recursive: true, force: true });

    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

    this.report({ requestId, phase: "done", done, total: jobs.length, message: outputPath });

    return { outputPath, format, entries, failures, warnings, totalBytes, cancelled: false };
  }
}

function logArgs(job: DownloadJob, request: CollectRequest): string[] {
  const args = ["logs", job.target.pod, "-n", job.target.namespace, "-c", job.container];

  if (request.logs.timestamps) args.push("--timestamps");
  if (job.previous) args.push("--previous");
  if (request.logs.sinceSeconds > 0) args.push(`--since=${request.logs.sinceSeconds}s`);
  if (request.logs.limitBytes > 0) args.push(`--limit-bytes=${request.logs.limitBytes}`);

  return args;
}

function describeError(error: unknown): string {
  if (error instanceof KubectlError) return error.message;
  if (error instanceof Error) return error.message;

  return String(error);
}

function buildManifest(
  request: CollectRequest,
  targets: PodTarget[],
  entries: CollectedEntry[],
  failures: CollectedEntry[],
  warnings: string[],
) {
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: "openlens-node-pod-menu / service logs",
    options: {
      logs: request.logs,
    },
    services: request.workloads.map(workload => ({
      cluster: workload.clusterId,
      namespace: workload.namespace,
      kind: workload.kind,
      name: workload.name,
      selector: workload.selector,
    })),
    pods: targets.map(target => ({
      cluster: target.clusterName,
      namespace: target.namespace,
      pod: target.pod,
      workload: target.workload,
      phase: target.phase,
      downloaded: target.containers,
      skipped: target.skipped,
    })),
    files: entries,
    failures,
    warnings,
  };
}

async function walk(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];

  for (const dirent of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      found.push(...await walk(root, relative));
    } else {
      found.push(relative);
    }
  }

  return found;
}

async function packZip(workDir: string, entries: CollectedEntry[], destination: string): Promise<string> {
  const target = destination.toLowerCase().endsWith(".zip") ? destination : `${destination}.zip`;

  await fs.mkdir(path.dirname(target), { recursive: true });

  const zip = new ZipWriter(target);

  for (const relative of await walk(workDir)) {
    await zip.addFile(relative, path.join(workDir, relative));
  }

  await zip.finalize();
  void entries;

  return target;
}

async function copyTree(workDir: string, destination: string): Promise<string> {
  await fs.mkdir(destination, { recursive: true });

  for (const relative of await walk(workDir)) {
    const target = path.join(destination, relative);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(workDir, relative), target);
  }

  return destination;
}

interface MergeCursor {
  label: string;
  iterator: AsyncIterator<string>;
  line?: string;
  timestamp: number;
  done: boolean;
}

async function mergeIntoSingleFile(
  workDir: string,
  entries: CollectedEntry[],
  destination: string,
  timestamps: boolean,
): Promise<string> {
  const target = /\.[a-z0-9]{1,5}$/i.test(destination) ? destination : `${destination}.log`;

  await fs.mkdir(path.dirname(target), { recursive: true });

  const out = createWriteStream(target);
  const write = (text: string) => new Promise<void>((resolve, reject) => {
    out.write(text, error => (error ? reject(error) : resolve()));
  });

  const files = entries.filter(entry => entry.bytes > 0);

  if (!timestamps) {
    for (const entry of files) {
      await write(`\n===== ${entry.cluster}/${entry.namespace}/${entry.pod}/${entry.container}`
        + `${entry.previous ? " (previous)" : ""} =====\n`);

      await new Promise<void>((resolve, reject) => {
        const source = createReadStream(path.join(workDir, entry.path));

        source.on("error", reject);
        source.on("end", () => resolve());
        source.pipe(out, { end: false });
      });
    }
  } else {
    const cursors: MergeCursor[] = [];

    for (const entry of files) {
      const stream = createReadStream(path.join(workDir, entry.path));
      const iterator = readline.createInterface({ input: stream, crlfDelay: Infinity })[Symbol.asyncIterator]();
      const cursor: MergeCursor = {
        label: `${entry.cluster}/${entry.namespace}/${entry.pod}/${entry.container}${entry.previous ? "(prev)" : ""}`,
        iterator,
        timestamp: 0,
        done: false,
      };

      await advance(cursor);
      cursors.push(cursor);
    }

    for (;;) {
      let next: MergeCursor | undefined;

      for (const cursor of cursors) {
        if (cursor.done) continue;
        if (!next || cursor.timestamp < next.timestamp) next = cursor;
      }

      if (!next) break;

      await write(`[${next.label}] ${next.line ?? ""}\n`);
      await advance(next);
    }
  }

  await new Promise<void>(resolve => out.end(() => resolve()));

  return target;
}

async function advance(cursor: MergeCursor): Promise<void> {
  const result = await cursor.iterator.next();

  if (result.done) {
    cursor.done = true;
    cursor.line = undefined;
    cursor.timestamp = Number.MAX_SAFE_INTEGER;

    return;
  }

  cursor.line = result.value;

  const space = result.value.indexOf(" ");
  const parsed = space > 0 ? Date.parse(result.value.slice(0, space)) : NaN;

  if (!Number.isNaN(parsed)) cursor.timestamp = parsed;
}
