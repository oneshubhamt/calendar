/**
 * Internal presentation primitive for ordered overlap geometry.
 *
 * Callers own sorting, overlap semantics and final geometry. This helper only
 * groups consecutive overlap-connected items and greedily assigns the first
 * non-overlapping visual lane within each group.
 */
export interface OverlapLanePlacement<T> {
  readonly item: T;
  readonly lane: number;
}

export interface OverlapLaneCluster<T> {
  readonly lanes: readonly (readonly T[])[];
  readonly placements: readonly OverlapLanePlacement<T>[];
}

export function partitionOverlapLanes<T>(
  items: readonly T[],
  overlaps: (left: T, right: T) => boolean,
): readonly OverlapLaneCluster<T>[] {
  const result: OverlapLaneCluster<T>[] = [];
  let cluster: T[] = [];

  const flush = (): void => {
    if (!cluster.length) return;

    const lanes: T[][] = [];
    const placements: OverlapLanePlacement<T>[] = [];
    for (const item of cluster) {
      let lane = lanes.findIndex(existing => existing.every(other => !overlaps(item, other)));
      if (lane < 0) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane]!.push(item);
      placements.push({ item, lane });
    }
    result.push({ lanes, placements });
    cluster = [];
  };

  for (const item of items) {
    if (cluster.length && !cluster.some(other => overlaps(item, other))) flush();
    cluster.push(item);
  }
  flush();

  return result;
}
