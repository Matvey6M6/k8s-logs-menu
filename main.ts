import { Common, Main } from "@k8slens/extensions";
import { app, BrowserWindow, dialog, shell } from "electron";
import * as path from "path";
import { LogCollector } from "./src/main/collector";
import { listNamespaces, listWorkloads } from "./src/main/k8s";
import { describeKubectl, Kubectl, resolveKubectl } from "./src/main/kubectl";
import { probeClusters } from "./src/main/probe";
import { Channels } from "./src/common/types";
import type {
  ClusterInfo,
  ClusterProbe,
  CollectRequest,
  CollectResult,
  KubectlInfo,
  NamespaceListing,
  PodTarget,
  ProgressEvent,
  ResolveTargetsRequest,
  WorkloadListing,
} from "./src/common/types";

interface CatalogClusterEntity {
  getId?: () => string;
  getName?: () => string;
  metadata?: { uid?: string; name?: string; source?: string };
  spec?: { kubeconfigPath?: string; kubeconfigContext?: string; accessibleNamespaces?: string[] };
}

function catalogClusters(): ClusterInfo[] {
  const entities = Main.Catalog.catalogEntities.getItemsForApiKind<CatalogClusterEntity & Common.Catalog.CatalogEntity>(
    Common.Catalog.KubernetesCluster.apiVersion,
    Common.Catalog.KubernetesCluster.kind,
  );

  return entities
    .map((entity): ClusterInfo => ({
      id: entity.getId?.() ?? entity.metadata?.uid ?? "",
      name: entity.getName?.() ?? entity.metadata?.name ?? "",
      kubeconfigPath: entity.spec?.kubeconfigPath ?? "",
      context: entity.spec?.kubeconfigContext ?? "",
      source: entity.metadata?.source,
      accessibleNamespaces: entity.spec?.accessibleNamespaces,
    }))
    .filter(cluster => Boolean(cluster.id && cluster.kubeconfigPath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function clusterMap(): Map<string, ClusterInfo> {
  return new Map(catalogClusters().map(cluster => [cluster.id, cluster]));
}

function requireCluster(clusterId: string): ClusterInfo {
  const cluster = clusterMap().get(clusterId);

  if (!cluster) throw new Error(`кластера "${clusterId}" нет в каталоге Lens`);

  return cluster;
}

function kubectlOptions(override?: string) {
  let preference: string | undefined;
  let userDataPath: string | undefined;

  try {
    preference = Common.App.Preferences.getKubectlPath();
  } catch {
    preference = undefined;
  }

  try {
    userDataPath = app.getPath("userData");
  } catch {
    userDataPath = undefined;
  }

  return { override, preference, userDataPath };
}

function requireKubectl(override?: string): Kubectl {
  const { path: binary } = resolveKubectl(kubectlOptions(override));

  if (!binary) {
    throw new Error("kubectl не найден — укажите путь к нему на странице Service logs");
  }

  return new Kubectl(binary);
}

export class ServiceLogsIpcMain extends Main.Ipc {
  private collectors = new Map<string, LogCollector>();

  constructor(extension: Main.LensExtension) {
    super(extension);

    this.handle(Channels.detectKubectl, async (_event, override?: string): Promise<KubectlInfo> => {
      return describeKubectl(kubectlOptions(override));
    });

    this.handle(Channels.listClusters, async (): Promise<ClusterInfo[]> => catalogClusters());

    this.handle(Channels.probeClusters, async (
      _event,
      clusterIds: string[],
      kubectlPath?: string,
    ): Promise<Record<string, ClusterProbe>> => {
      const catalog = clusterMap();
      const targets = (clusterIds ?? [])
        .map(id => catalog.get(id))
        .filter((cluster): cluster is ClusterInfo => Boolean(cluster));

      return probeClusters(requireKubectl(kubectlPath), targets);
    });

    this.handle(Channels.listNamespaces, async (
      _event,
      clusterId: string,
      kubectlPath?: string,
    ): Promise<NamespaceListing> => {
      const cluster = requireCluster(clusterId);
      const listing = await listNamespaces(requireKubectl(kubectlPath), cluster);

      if (listing.namespaces.length === 0 && cluster.accessibleNamespaces?.length) {
        return { namespaces: [...cluster.accessibleNamespaces].sort(), warnings: listing.warnings };
      }

      return listing;
    });

    this.handle(Channels.listWorkloads, async (
      _event,
      clusterId: string,
      namespaces: string[],
      kubectlPath?: string,
    ): Promise<WorkloadListing> => {
      return listWorkloads(requireKubectl(kubectlPath), requireCluster(clusterId), namespaces ?? []);
    });

    this.handle(Channels.resolveTargets, async (
      _event,
      request: ResolveTargetsRequest,
    ): Promise<{ targets: PodTarget[]; warnings: string[] }> => {
      const collector = new LogCollector(requireKubectl(request.kubectlPath), clusterMap(), () => undefined);

      return collector.resolveTargets(request);
    });

    this.handle(Channels.collect, async (_event, request: CollectRequest): Promise<CollectResult> => {
      const collector = new LogCollector(
        requireKubectl(request.kubectlPath),
        clusterMap(),
        (progress: ProgressEvent) => this.broadcast(Channels.progress, progress),
      );

      this.collectors.set(request.requestId, collector);

      try {
        return await collector.collect(request);
      } finally {
        this.collectors.delete(request.requestId);
      }
    });

    this.handle(Channels.cancel, async (_event, requestId: string): Promise<boolean> => {
      const collector = this.collectors.get(requestId);

      collector?.cancel(requestId);

      return Boolean(collector);
    });

    this.handle(Channels.chooseOutput, async (
      _event,
      options: { format: string; defaultName: string },
    ): Promise<string | undefined> => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const downloads = (() => {
        try {
          return app.getPath("downloads");
        } catch {
          return process.cwd();
        }
      })();

      if (options.format === "folder") {
        const result = parent
          ? await dialog.showOpenDialog(parent, {
            title: "Куда сохранить логи?",
            defaultPath: downloads,
            properties: ["openDirectory", "createDirectory"],
          })
          : await dialog.showOpenDialog({
            title: "Куда сохранить логи?",
            defaultPath: downloads,
            properties: ["openDirectory", "createDirectory"],
          });

        if (result.canceled || result.filePaths.length === 0) return undefined;

        return path.join(result.filePaths[0], options.defaultName);
      }

      const extension = options.format === "zip" ? "zip" : "log";
      const saveOptions = {
        title: "Сохранение логов сервиса",
        defaultPath: path.join(downloads, `${options.defaultName}.${extension}`),
        filters: [
          options.format === "zip"
            ? { name: "Zip-архив", extensions: ["zip"] }
            : { name: "Файл лога", extensions: ["log", "txt"] },
        ],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, saveOptions)
        : await dialog.showSaveDialog(saveOptions);

      return result.canceled ? undefined : result.filePath;
    });

    this.handle(Channels.revealOutput, async (_event, target: string): Promise<void> => {
      shell.showItemInFolder(target);
    });
  }
}

export default class PodMenuMainExtension extends Main.LensExtension {
  async onActivate(): Promise<void> {
    ServiceLogsIpcMain.createInstance(this);
  }

  async onDeactivate(): Promise<void> {
    ServiceLogsIpcMain.resetInstance();
  }
}
