import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Renderer } from "@k8slens/extensions";
import { globMatch } from "../common/containers";
import { pool } from "../common/pool";
import { isInScope, namespacesOfCluster, pruneNamespaceSelection, pruneToScope } from "../common/scope";
import { Channels } from "../common/types";
import type {
  ClusterInfo,
  ClusterProbe,
  CollectRequest,
  CollectResult,
  KubectlInfo,
  LogOptions,
  NamespaceListing,
  OutputFormat,
  PodTarget,
  ProgressEvent,
  WorkloadInfo,
  WorkloadListing,
  WorkloadSelection,
} from "../common/types";
import { serviceLogsIpc } from "./ipc";

const {
  Component: {
    Button,
    Checkbox,
    Icon,
    Input,
    Notifications,
    Spinner,
  },
} = Renderer;

const SETTINGS_KEY = "openlens-service-logs:settings";

interface PersistedSettings {
  kubectlPath: string;
  logs: LogOptions;
  format: OutputFormat;
  concurrency: number;
}

const defaultSettings: PersistedSettings = {
  kubectlPath: "",
  logs: {
    timestamps: true,
    sinceSeconds: 0,
    previous: false,
    limitBytes: 0,
  },
  format: "zip",
  concurrency: 4,
};

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);

    if (!raw) return defaultSettings;

    const parsed = JSON.parse(raw);

    return {
      ...defaultSettings,
      ...parsed,
      logs: {
        timestamps: parsed.logs?.timestamps ?? defaultSettings.logs.timestamps,
        sinceSeconds: parsed.logs?.sinceSeconds ?? defaultSettings.logs.sinceSeconds,
        previous: parsed.logs?.previous ?? defaultSettings.logs.previous,
        limitBytes: parsed.logs?.limitBytes ?? defaultSettings.logs.limitBytes,
      },
    };
  } catch {
    return defaultSettings;
  }
}

function saveSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {

  }
}

function workloadKey(workload: { clusterId: string; namespace: string; kind: string; name: string }): string {
  return `${workload.clusterId}//${workload.namespace}//${workload.kind}//${workload.name}`;
}

interface ClusterStat {
  clusterId: string;
  name: string;

  namespaces: number;
  found: number;
  note?: string;
}

function matchesQuery(value: string, query: string): boolean {
  const trimmed = query.trim();

  if (!trimmed) return true;

  return trimmed
    .split(/[\s,]+/)
    .filter(Boolean)
    .some(part => (part.includes("*") || part.includes("?"))
      ? globMatch(part, value)
      : value.toLowerCase().includes(part.toLowerCase()));
}

const PHASE_LABELS: Record<string, string> = {
  resolving: "Поиск подов",
  downloading: "Скачивание",
  packaging: "Упаковка",
  done: "Готово",
  cancelled: "Отменено",
  error: "Ошибка",
};

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    padding: "24px 32px 64px",
    overflow: "auto",
    height: "100%",
    color: "var(--textColorPrimary)",
  },
  section: {
    background: "var(--contentColor)",
    border: "1px solid var(--borderFaintColor)",
    borderRadius: 4,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: "var(--font-size-big)",
    fontWeight: 500,
    marginBottom: 12,
  },
  hint: {
    color: "var(--textColorTertiary)",
    fontSize: "var(--font-size-small)",
    marginBottom: 8,
  },
  list: {
    maxHeight: 260,
    overflow: "auto",
    border: "1px solid var(--borderFaintColor)",
    borderRadius: 4,
    padding: 8,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "2px 4px",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    flexWrap: "wrap",
  },
  mono: {
    fontFamily: "var(--font-monospace)",
    fontSize: "var(--font-size-small)",
    color: "var(--textColorSecondary)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 12,
  },
  badge: {
    fontSize: "var(--font-size-small)",
    color: "var(--textColorTertiary)",
    border: "1px solid var(--borderFaintColor)",
    borderRadius: 10,
    padding: "0 8px",
  },
};

function WarningList({ title, warnings }: { title: string; warnings: string[] }): React.ReactElement | null {
  if (warnings.length === 0) return null;

  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ ...styles.hint, color: "var(--colorWarning)", cursor: "pointer", marginBottom: 0 }}>
        {title} ({warnings.length})
      </summary>
      <div style={{ ...styles.mono, padding: "4px 0 0 16px" }}>
        {warnings.map(warning => <div key={warning}>{warning}</div>)}
      </div>
    </details>
  );
}

function StatLine({ stats }: { stats: ClusterStat[] }): React.ReactElement | null {
  if (stats.length === 0) return null;

  return (
    <div style={{ ...styles.toolbar, marginTop: 8, marginBottom: 0 }}>
      {stats.map(stat => (
        <span
          key={stat.clusterId}
          style={{
            ...styles.badge,
            color: stat.found === 0 ? "var(--colorWarning)" : "var(--textColorSecondary)",
            borderColor: stat.found === 0 ? "var(--colorWarning)" : "var(--borderFaintColor)",
          }}
        >
          {stat.name}: {stat.found} сервисов
          {stat.note ? ` (${stat.note})` : ` в ${stat.namespaces} segments`}
        </span>
      ))}
    </div>
  );
}

function NamespaceStatLine({ stats }: { stats: { clusterId: string; name: string; count: number }[] }) {
  if (stats.length === 0) return null;

  return (
    <div style={{ ...styles.toolbar, marginTop: 8, marginBottom: 0 }}>
      {stats.map(stat => (
        <span
          key={stat.clusterId}
          style={{
            ...styles.badge,
            color: stat.count === 0 ? "var(--colorWarning)" : "var(--textColorSecondary)",
            borderColor: stat.count === 0 ? "var(--colorWarning)" : "var(--borderFaintColor)",
          }}
        >
          {stat.name}: {stat.count} namespaces
        </span>
      ))}
    </div>
  );
}

function ProbeBadge({ probe }: { probe?: ClusterProbe }): React.ReactElement | null {
  if (!probe) return null;

  const view = (() => {
    switch (probe.state) {
    case "checking":
      return { label: "проверяю...", color: "var(--textColorTertiary)" };
    case "ok":
      return { label: probe.version || "доступен", color: "var(--colorSuccess)" };
    case "denied":
      return { label: "нет доступа", color: "var(--colorError)" };
    case "offline":
      return { label: "не отвечает", color: "var(--colorError)" };
    default:
      return { label: "ошибка", color: "var(--colorError)" };
    }
  })();

  return (
    <span style={{ ...styles.badge, color: view.color, borderColor: view.color }} title={probe.message}>
      {view.label}
    </span>
  );
}

export function ServiceLogsPage(): React.ReactElement {
  const ipc = () => serviceLogsIpc();
  const [settings, setSettings] = useState<PersistedSettings>(loadSettings);
  const [kubectl, setKubectl] = useState<KubectlInfo | undefined>();

  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [clusterQuery, setClusterQuery] = useState("");
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
  const [probes, setProbes] = useState<Record<string, ClusterProbe>>({});

  const [namespaces, setNamespaces] = useState<Record<string, string[]>>({});
  const [namespaceMask, setNamespaceMask] = useState("");
  const [selectedNamespaces, setSelectedNamespaces] = useState<string[]>([]);
  const [loadingNamespaces, setLoadingNamespaces] = useState(false);
  const [namespaceWarnings, setNamespaceWarnings] = useState<string[]>([]);

  const [workloads, setWorkloads] = useState<WorkloadInfo[]>([]);
  const [serviceQuery, setServiceQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, WorkloadSelection>>({});
  const [loadingWorkloads, setLoadingWorkloads] = useState(false);
  const [workloadWarnings, setWorkloadWarnings] = useState<string[]>([]);
  const [workloadStats, setWorkloadStats] = useState<ClusterStat[]>([]);

  const [targets, setTargets] = useState<PodTarget[] | undefined>();
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | undefined>();
  const [result, setResult] = useState<CollectResult | undefined>();
  const [running, setRunning] = useState(false);
  const requestId = useRef<string>("");
  const previousScope = useRef<{ clusters: string[]; namespaces: string[] }>({ clusters: [], namespaces: [] });

  const update = useCallback((patch: Partial<PersistedSettings>) => {
    setSettings(previous => {
      const next = { ...previous, ...patch };

      saveSettings(next);

      return next;
    });
  }, []);

  useEffect(() => {
    const dispose = ipc().listen(Channels.progress, (_event: unknown, event: ProgressEvent) => {
      if (!requestId.current || event.requestId === requestId.current) setProgress(event);
    });

    return () => dispose?.();
  }, []);

  useEffect(() => {
    setSelectedNamespaces(previous => {
      const next = pruneNamespaceSelection(namespaces, selectedClusters, previous);

      return next.length === previous.length ? previous : next;
    });
  }, [namespaces, selectedClusters]);

  useEffect(() => {

    const previousSelection = previousScope.current;
    const removedNamespaces = previousSelection.namespaces.filter(
      namespace => !selectedNamespaces.includes(namespace),
    );

    previousScope.current = { clusters: selectedClusters, namespaces: selectedNamespaces };

    setWorkloads(previous => pruneToScope(previous, selectedClusters, selectedNamespaces, removedNamespaces));
    setWorkloadStats(previous => {
      const next = previous.filter(stat => selectedClusters.includes(stat.clusterId));

      return next.length === previous.length ? previous : next;
    });
    setSelected(previous => {
      const next: Record<string, WorkloadSelection> = {};
      let changed = false;

      for (const [key, selection] of Object.entries(previous)) {
        if (isInScope(selection, selectedClusters, selectedNamespaces, removedNamespaces)) {
          next[key] = selection;
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [selectedClusters, selectedNamespaces]);

  useEffect(() => {
    setTargets(undefined);
    setPreviewWarnings(previous => (previous.length === 0 ? previous : []));
  }, [selected, selectedClusters, selectedNamespaces]);

  const detectKubectl = useCallback(async (override: string) => {
    try {
      setKubectl(await ipc().invoke(Channels.detectKubectl, override || undefined));
    } catch (error) {
      setKubectl({ error: String(error), searched: [] });
    }
  }, []);

  const probeClusters = useCallback(async (list: ClusterInfo[]) => {
    if (list.length === 0) return;

    setProbes(Object.fromEntries(list.map(cluster => [cluster.id, { state: "checking" as const }])));

    try {
      const checked: Record<string, ClusterProbe> = await ipc().invoke(
        Channels.probeClusters,
        list.map(cluster => cluster.id),
        settings.kubectlPath || undefined,
      );

      setProbes(previous => ({ ...previous, ...checked }));
    } catch (error) {
      setProbes(Object.fromEntries(list.map(cluster => [
        cluster.id,
        { state: "error" as const, message: String(error) },
      ])));
    }
  }, [settings.kubectlPath]);

  const loadClusters = useCallback(async () => {
    try {
      const list: ClusterInfo[] = await ipc().invoke(Channels.listClusters);

      setClusters(list);
      void probeClusters(list);
    } catch (error) {
      Notifications.error(`Не удалось прочитать каталог кластеров: ${error}`);
    }
  }, [probeClusters]);

  useEffect(() => {
    void loadClusters();
    void detectKubectl(settings.kubectlPath);
  }, []);

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter(item => item !== value) : [...list, value];

  const loadNamespaces = useCallback(async () => {
    if (selectedClusters.length === 0) {
      Notifications.info("Сначала выберите хотя бы один cluster");

      return;
    }

    setLoadingNamespaces(true);
    setNamespaceWarnings([]);

    const answers = await pool(selectedClusters, 6, async clusterId => {
      const name = clusters.find(cluster => cluster.id === clusterId)?.name ?? clusterId;

      try {
        const listing: NamespaceListing = await ipc().invoke(
          Channels.listNamespaces,
          clusterId,
          settings.kubectlPath || undefined,
        );

        return { clusterId, namespaces: listing.namespaces, warnings: listing.warnings };
      } catch (error) {
        return { clusterId, namespaces: [] as string[], warnings: [`${name}: ${error}`] };
      }
    });

    const collected: Record<string, string[]> = {};
    const problems: string[] = [];

    for (const answer of answers) {
      collected[answer.clusterId] = answer.namespaces;
      problems.push(...answer.warnings);
    }

    setNamespaces(collected);
    setNamespaceWarnings(problems);
    setLoadingNamespaces(false);
  }, [selectedClusters, settings.kubectlPath, clusters]);

  const allNamespaces = useMemo(() => {
    const counts = new Map<string, number>();

    for (const clusterId of selectedClusters) {
      for (const namespace of namespaces[clusterId] ?? []) {
        counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [namespaces, selectedClusters]);

  const namespaceStats = useMemo(
    () => selectedClusters
      .filter(clusterId => namespaces[clusterId] !== undefined)
      .map(clusterId => ({
        clusterId,
        name: clusters.find(cluster => cluster.id === clusterId)?.name ?? clusterId,
        count: (namespaces[clusterId] ?? []).length,
      })),
    [namespaces, selectedClusters, clusters],
  );

  const visibleNamespaces = useMemo(
    () => allNamespaces.filter(item => matchesQuery(item.name, namespaceMask)),
    [allNamespaces, namespaceMask],
  );

  const loadWorkloads = useCallback(async () => {
    if (selectedClusters.length === 0) {
      Notifications.info("Сначала выберите хотя бы один cluster");

      return;
    }

    setLoadingWorkloads(true);
    setWorkloads([]);
    setWorkloadWarnings([]);
    setWorkloadStats([]);

    const answers = await pool(selectedClusters, 3, async clusterId => {
      const name = clusters.find(cluster => cluster.id === clusterId)?.name ?? clusterId;
      const scope = namespacesOfCluster(namespaces, clusterId, selectedNamespaces);
      const empty: WorkloadInfo[] = [];

      if (selectedNamespaces.length > 0 && namespaces[clusterId] && scope.length === 0) {
        return {
          workloads: empty,
          warnings: [] as string[],
          stat: { clusterId, name, namespaces: 0, found: 0, note: "выбранных сегментов здесь нет" } as ClusterStat,
        };
      }

      try {
        const listing: WorkloadListing = await ipc().invoke(
          Channels.listWorkloads,
          clusterId,
          scope,
          settings.kubectlPath || undefined,
        );

        return {
          workloads: listing.workloads,
          warnings: listing.warnings,
          stat: {
            clusterId,
            name,
            namespaces: scope.length,
            found: listing.workloads.length,
            note: scope.length === 0 ? "все namespaces" : undefined,
          } as ClusterStat,
        };
      } catch (error) {
        return {
          workloads: empty,
          warnings: [`${name}: ${error}`],
          stat: { clusterId, name, namespaces: scope.length, found: 0, note: "ошибка запроса" } as ClusterStat,
        };
      }
    });

    const collected: WorkloadInfo[] = [];
    const problems: string[] = [];
    const stats: ClusterStat[] = [];

    for (const answer of answers) {
      collected.push(...answer.workloads);
      problems.push(...answer.warnings);
      stats.push(answer.stat);
    }

    setWorkloads(collected);
    setWorkloadWarnings(problems);
    setWorkloadStats(stats);
    setLoadingWorkloads(false);
  }, [selectedClusters, selectedNamespaces, namespaces, settings.kubectlPath, clusters]);

  const visibleWorkloads = useMemo(
    () => workloads.filter(workload => matchesQuery(workload.name, serviceQuery)),
    [workloads, serviceQuery],
  );

  const selectedList = useMemo(() => Object.values(selected), [selected]);

  const toggleWorkload = (workload: WorkloadInfo) => {
    const key = workloadKey(workload);

    setSelected(previous => {
      const next = { ...previous };

      if (next[key]) {
        delete next[key];
      } else {
        next[key] = {
          clusterId: workload.clusterId,
          namespace: workload.namespace,
          kind: workload.kind,
          name: workload.name,
          selector: workload.selector,
        };
      }

      return next;
    });
    setTargets(undefined);
  };

  const preview = useCallback(async () => {
    if (selectedList.length === 0) {
      Notifications.info("Сначала выберите хотя бы один service");

      return;
    }

    setPreviewing(true);

    try {
      const response: { targets: PodTarget[]; warnings: string[] } = await ipc().invoke(Channels.resolveTargets, {
        kubectlPath: settings.kubectlPath || undefined,
        workloads: selectedList,
      });

      setTargets(response.targets);
      setPreviewWarnings(response.warnings);
    } catch (error) {
      Notifications.error(String(error));
    } finally {
      setPreviewing(false);
    }
  }, [selectedList, settings]);

  const download = useCallback(async () => {
    if (selectedList.length === 0) {
      Notifications.info("Сначала выберите хотя бы один service");

      return;
    }

    const first = selectedList[0];

    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const defaultName = selectedList.length === 1
      ? `${first.name.slice(0, 24)}-logs-${stamp}`
      : `service-logs-${stamp}`;

    let outputPath: string | undefined;

    try {
      outputPath = await ipc().invoke(Channels.chooseOutput, { format: settings.format, defaultName });
    } catch (error) {
      Notifications.error(String(error));

      return;
    }

    if (!outputPath) return;

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    requestId.current = id;

    const request: CollectRequest = {
      requestId: id,
      kubectlPath: settings.kubectlPath || undefined,
      workloads: selectedList,
      logs: settings.logs,
      output: { format: settings.format, path: outputPath },
      concurrency: settings.concurrency,
    };

    setRunning(true);
    setResult(undefined);
    setProgress({ requestId: id, phase: "resolving", done: 0, total: 0, message: "Запуск..." });

    try {
      const response: CollectResult = await ipc().invoke(Channels.collect, request);

      setResult(response);

      setProbes(previous => {
        const next = { ...previous };

        for (const entry of response.entries) {
          if (entry.clusterId) next[entry.clusterId] = { state: "ok", version: previous[entry.clusterId]?.version };
        }

        for (const failure of response.failures) {
          if (failure.clusterId) next[failure.clusterId] = { state: "error", message: failure.error };
        }

        return next;
      });

      if (response.cancelled) {
        Notifications.info("Выгрузка отменена");
      } else if (response.failures.length > 0) {
        Notifications.info(`Сохранено, но не удалось скачать контейнеров: ${response.failures.length}`);
      } else {
        Notifications.ok(`Логи сохранены: ${response.outputPath}`);
      }
    } catch (error) {
      Notifications.error(`Не удалось выгрузить логи: ${error}`);
      setProgress(undefined);
    } finally {
      setRunning(false);
      requestId.current = "";
    }
  }, [selectedList, settings]);

  const cancel = useCallback(async () => {
    if (requestId.current) await ipc().invoke(Channels.cancel, requestId.current);
  }, []);

  const visibleClusters = clusters.filter(cluster => matchesQuery(cluster.name, clusterQuery)
    || matchesQuery(cluster.context ?? "", clusterQuery));

  const podCount = targets?.length ?? 0;
  const containerCount = targets?.reduce((sum, target) => sum + target.containers.length, 0) ?? 0;

  return (
    <div style={styles.page}>
      <div style={{ ...styles.sectionTitle, fontSize: 20, marginBottom: 20 }}>
        <Icon material="cloud_download"/>
        <span>Выгрузка логов сервиса</span>
      </div>

      {kubectl?.error && (
        <div style={{ ...styles.section, borderColor: "var(--colorError)" }}>
          <div style={styles.sectionTitle}>
            <Icon material="error_outline" style={{ color: "var(--colorError)" }}/>
            <span>Нужен kubectl</span>
          </div>
          <div style={styles.hint}>{kubectl.error}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              placeholder="/usr/local/bin/kubectl"
              value={settings.kubectlPath}
              onChange={(value: string) => update({ kubectlPath: value })}
              style={{ flexGrow: 1 }}
            />
            <Button primary label="Проверить" onClick={() => void detectKubectl(settings.kubectlPath)}/>
          </div>
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          <span>1. Clusters</span>
          <span style={styles.badge}>выбрано: {selectedClusters.length}</span>
        </div>
        <div style={styles.toolbar}>
          <Input
            placeholder="Фильтр по имени или context (поддерживает маски *)"
            value={clusterQuery}
            onChange={setClusterQuery}
            style={{ flexGrow: 1, minWidth: 220 }}
          />
          <Button plain label="Все" onClick={() => setSelectedClusters(visibleClusters.map(c => c.id))}/>
          <Button plain label="Снять все" onClick={() => setSelectedClusters([])}/>
          <Button plain label="Обновить" onClick={() => void loadClusters()}/>
        </div>
        <div style={styles.list}>
          {visibleClusters.length === 0 && <div style={styles.hint}>В каталоге Lens нет кластеров</div>}
          {visibleClusters.map(cluster => (
            <div key={cluster.id} style={styles.row}>
              <Checkbox
                value={selectedClusters.includes(cluster.id)}
                onChange={() => {
                  setSelectedClusters(previous => toggle(previous, cluster.id));
                  setTargets(undefined);
                }}
                label={cluster.name}
              />
              <span style={styles.mono}>{cluster.context}</span>
              <ProbeBadge probe={probes[cluster.id]}/>
            </div>
          ))}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          <span>2. Segments (namespaces)</span>
          <span style={styles.badge}>
            {selectedNamespaces.length === 0 ? "все namespaces" : `выбрано: ${selectedNamespaces.length}`}
          </span>
        </div>
        <div style={styles.toolbar}>
          <Input
            placeholder="Маска, например segment-*"
            value={namespaceMask}
            onChange={setNamespaceMask}
            style={{ flexGrow: 1, minWidth: 220 }}
          />
          <Button primary label="Загрузить segments" onClick={() => void loadNamespaces()} waiting={loadingNamespaces}/>
          <Button
            plain
            label="Выбрать показанные"
            onClick={() => setSelectedNamespaces(visibleNamespaces.map(item => item.name))}
          />
          <Button plain label="Очистить" onClick={() => setSelectedNamespaces([])}/>
        </div>
        {loadingNamespaces
          ? <Spinner center/>
          : (
            <div style={styles.list}>
              {visibleNamespaces.length === 0 && (
                <div style={styles.hint}>Список пуст — нажмите &quot;Загрузить segments&quot;</div>
              )}
              {visibleNamespaces.map(item => (
                <div key={item.name} style={styles.row}>
                  <Checkbox
                    value={selectedNamespaces.includes(item.name)}
                    onChange={() => {
                      setSelectedNamespaces(previous => toggle(previous, item.name));
                      setTargets(undefined);
                    }}
                    label={item.name}
                  />
                  {selectedClusters.length > 1 && (
                    <span style={styles.badge}>в {item.count} из {selectedClusters.length} кластеров</span>
                  )}
                </div>
              ))}
            </div>
          )}
        <NamespaceStatLine stats={namespaceStats}/>
        <WarningList title="Часть namespaces прочитать не удалось" warnings={namespaceWarnings}/>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          <span>3. Service</span>
          <span style={styles.badge}>выбрано: {selectedList.length}</span>
        </div>
        <div style={styles.toolbar}>
          <Input
            placeholder="Имя сервиса, например billing или billing-*"
            value={serviceQuery}
            onChange={setServiceQuery}
            style={{ flexGrow: 1, minWidth: 260 }}
          />
          <Button primary label="Найти сервисы" onClick={() => void loadWorkloads()} waiting={loadingWorkloads}/>
          <Button
            plain
            label="Выбрать все найденные"
            onClick={() => {
              const next = { ...selected };

              for (const workload of visibleWorkloads) next[workloadKey(workload)] = {
                clusterId: workload.clusterId,
                namespace: workload.namespace,
                kind: workload.kind,
                name: workload.name,
                selector: workload.selector,
              };

              setSelected(next);
              setTargets(undefined);
            }}
          />
          <Button plain label="Очистить" onClick={() => { setSelected({}); setTargets(undefined); }}/>
        </div>
        {loadingWorkloads
          ? <Spinner center/>
          : (
            <div style={styles.list}>
              {visibleWorkloads.length === 0 && (
                <div style={styles.hint}>
                  Пока ничего не найдено — выберите clusters и segments и нажмите &quot;Найти сервисы&quot;.
                </div>
              )}
              {visibleWorkloads.map(workload => {
                const key = workloadKey(workload);
                const isSelected = Boolean(selected[key]);

                return (
                  <div key={key} style={styles.row}>
                    <Checkbox
                      value={isSelected}
                      onChange={() => toggleWorkload(workload)}
                      label={workload.name}
                    />
                    <span style={styles.mono}>
                      {workload.clusterName} / {workload.namespace} / {workload.kind}
                    </span>
                    <span style={styles.badge}>
                      {workload.readyReplicas ?? 0}/{workload.replicas ?? 0} ready
                    </span>
                    {workload.defaultContainer && (
                      <span style={styles.badge}>log: {workload.defaultContainer}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        <StatLine stats={workloadStats}/>
        <WarningList title="Namespaces без доступа пропущены" warnings={workloadWarnings}/>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}><span>4. Параметры логов</span></div>
        <div style={styles.grid}>
          <div>
            <Checkbox
              label="Timestamps (нужны, чтобы объединять поды по времени)"
              value={settings.logs.timestamps}
              onChange={(value: boolean) => update({ logs: { ...settings.logs, timestamps: value } })}
            />
            <Checkbox
              label="Также логи предыдущего запуска (--previous) для перезапущенных контейнеров"
              value={settings.logs.previous}
              onChange={(value: boolean) => update({ logs: { ...settings.logs, previous: value } })}
            />
            <div style={{ marginTop: 8 }}>
              <div style={styles.hint}>Только за последние N минут (0 — весь лог целиком)</div>
              <Input
                type="number"
                value={String(Math.round(settings.logs.sinceSeconds / 60))}
                onChange={(value: string) => update({
                  logs: { ...settings.logs, sinceSeconds: (Number(value) || 0) * 60 },
                })}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}><span>5. Выгрузка</span></div>
        <div style={styles.toolbar}>
          {(["zip", "folder", "single"] as const).map(format => (
            <label key={format} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="radio"
                checked={settings.format === format}
                onChange={() => update({ format })}
              />
              <span>
                {format === "zip" && "Zip-архив (файл на под)"}
                {format === "folder" && "Папка (файл на под)"}
                {format === "single" && "Один общий файл, строки по времени"}
              </span>
            </label>
          ))}
        </div>
        <div style={styles.toolbar}>
          <Button label="Показать, что будет скачано" onClick={() => void preview()} waiting={previewing}/>
          <Button primary label="Скачать" onClick={() => void download()} waiting={running} disabled={running}/>
          {running && <Button accent label="Отменить" onClick={() => void cancel()}/>}
        </div>

        {progress && (
          <div style={{ marginTop: 12 }}>
            <div style={styles.hint}>
              {PHASE_LABELS[progress.phase] ?? progress.phase} - {progress.done}/{progress.total} {progress.message}
            </div>
            <div style={{ height: 6, background: "var(--borderFaintColor)", borderRadius: 3 }}>
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: "var(--colorSuccess)",
                  width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  transition: "width .2s",
                }}
              />
            </div>
          </div>
        )}

        {targets && (
          <div style={{ marginTop: 16 }}>
            <div style={styles.hint}>
              Подов: {podCount}, будет скачано логов контейнеров: {containerCount}
            </div>
            <WarningList title="Часть сервисов прочитать не удалось" warnings={previewWarnings}/>
            <div style={styles.list}>
              {targets.map(target => (
                <div key={`${target.clusterId}/${target.namespace}/${target.pod}`} style={{ padding: "4px 0" }}>
                  <div style={styles.mono}>
                    {target.clusterName} / {target.namespace} / {target.pod} ({target.phase})
                  </div>
                  <div style={{ paddingLeft: 16 }}>
                    {target.containers.map(container => (
                      <div key={`take-${container.name}`} style={{ color: "var(--colorSuccess)" }}>
                        + {container.name}
                      </div>
                    ))}
                    {target.skipped.map(container => (
                      <div key={`skip-${container.name}`} style={{ color: "var(--textColorTertiary)" }}>
                        - {container.name}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon material={result.failures.length ? "warning" : "check_circle"}/>
              <span style={styles.mono}>{result.outputPath}</span>
              <span style={styles.badge}>файлов: {result.entries.length}, {humanBytes(result.totalBytes)}</span>
              <Button
                plain
                label="Показать в папке"
                onClick={() => void ipc().invoke(Channels.revealOutput, result.outputPath)}
              />
            </div>
            {result.warnings.map(warning => (
              <div key={warning} style={{ ...styles.hint, color: "var(--colorWarning)" }}>{warning}</div>
            ))}
            {result.failures.map(failure => (
              <div key={`${failure.pod}-${failure.container}`} style={{ ...styles.hint, color: "var(--colorError)" }}>
                {failure.pod} / {failure.container}: {failure.error}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ServiceLogsPage;
