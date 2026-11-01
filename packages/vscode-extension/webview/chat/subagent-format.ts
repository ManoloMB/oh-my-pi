/** Status labels and run-time formatting shared by the subagent panel and its request popup. */
import type { SubagentView } from "../../src/protocol";

export const STATUS_LABELS: Record<SubagentView["status"], string> = {
	pending: "Queued",
	running: "Running",
	completed: "Done",
	failed: "Failed",
	aborted: "Stopped",
};

export function isActive(row: SubagentView): boolean {
	return row.status === "pending" || row.status === "running";
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Run time: live for running rows, omp's reported time once finished. */
export function elapsedMs(row: SubagentView, now: number): number {
	return isActive(row) ? Math.max(row.durationMs, now - row.startedAt) : row.durationMs || now - row.startedAt;
}
