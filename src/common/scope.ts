export interface ScopedItem {
  clusterId: string;
  namespace: string;
}

export function namespacesOfCluster(
  known: Record<string, string[]>,
  clusterId: string,
  selected: string[],
): string[] {
  
  if (selected.length === 0) return [];

  const own = known[clusterId];

  if (!own) return selected;

  return selected.filter(namespace => own.includes(namespace));
}

export function pruneNamespaceSelection(
  known: Record<string, string[]>,
  selectedClusters: string[],
  selected: string[],
): string[] {
  if (selected.length === 0) return selected;
  if (selectedClusters.length === 0) return [];

  const allowed = new Set<string>();
  const elsewhere = new Set<string>();

  for (const [clusterId, namespaces] of Object.entries(known)) {
    const target = selectedClusters.includes(clusterId) ? allowed : elsewhere;

    for (const namespace of namespaces) target.add(namespace);
  }

  const kept = selected.filter(namespace => allowed.has(namespace) || !elsewhere.has(namespace));

  return kept.length === selected.length ? selected : kept;
}

export function isInScope(
  item: ScopedItem,
  selectedClusters: string[],
  selectedNamespaces: string[],
  removedNamespaces: string[] = [],
): boolean {
  if (!selectedClusters.includes(item.clusterId)) return false;
  if (removedNamespaces.includes(item.namespace)) return false;

  return selectedNamespaces.length === 0 || selectedNamespaces.includes(item.namespace);
}

export function pruneToScope<T extends ScopedItem>(
  items: T[],
  selectedClusters: string[],
  selectedNamespaces: string[],
  removedNamespaces: string[] = [],
): T[] {
  const kept = items.filter(item => isInScope(item, selectedClusters, selectedNamespaces, removedNamespaces));

  return kept.length === items.length ? items : kept;
}
