/**
 * Main-thread client of the session-search worker. The main thread only posts
 * messages; indexing runs in the worker against its own connection. When the
 * worker cannot start, passes run inline with a small budget instead.
 */
import { getSessionSearchDbPath, getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { SESSION_SEARCH_WORKER_ARG } from "../../cli/worker-selectors";
import { type ReconcileOptions, reconcile } from "./indexer";
import type { SessionSearchWorkerRequest, SessionSearchWorkerResponse } from "./protocol";
import { openSessionSearchDb } from "./schema";

export interface SessionSearchReconcileOptions {
	scopeCwd?: string;
	budgetMs: number;
	indexThinking?: boolean;
}

/** Inline fallback budget cap: the main thread must never stall on indexing. */
const INLINE_BUDGET_MS = 150;
/** Idle worker lifetime after its last response. */
const IDLE_TERMINATE_MS = 60_000;
/** Grace past the requested budget before a pass is reported incomplete. */
const RESPONSE_GRACE_MS = 5_000;

interface PendingRequest {
	resolve(response: SessionSearchWorkerResponse): void;
	reject(error: Error): void;
}

export class SessionSearchIndexClient {
	static #global: SessionSearchIndexClient | undefined;

	static global(): SessionSearchIndexClient {
		SessionSearchIndexClient.#global ??= new SessionSearchIndexClient();
		return SessionSearchIndexClient.#global;
	}

	/** Terminate the global worker. Test-only. */
	static resetGlobalForTests(): void {
		SessionSearchIndexClient.#global?.dispose();
		SessionSearchIndexClient.#global = undefined;
	}

	/** Stop the worker; a later pass starts a new one. */
	dispose(): void {
		this.#terminate();
	}

	#worker: Worker | undefined;
	#workerFailed = false;
	#nextId = 1;
	readonly #pending = new Map<number, PendingRequest>();
	#idleTimer: NodeJS.Timeout | undefined;

	/** Run one incremental pass; `complete: false` means files remain unindexed. */
	async reconcile(opts: SessionSearchReconcileOptions): Promise<{ complete: boolean }> {
		const dbPath = getSessionSearchDbPath();
		const sessionsRoot = getSessionsDir();
		const indexThinking = opts.indexThinking ?? false;
		const inline = { sessionsRoot, scopeCwd: opts.scopeCwd, budgetMs: opts.budgetMs, indexThinking };
		if (!this.#ensureWorker()) return this.#reconcileInline(inline);
		let response: SessionSearchWorkerResponse | undefined;
		try {
			response = await this.#request(
				{ type: "reconcile", id: this.#nextId++, dbPath, ...inline },
				opts.budgetMs + RESPONSE_GRACE_MS,
			);
		} catch (error) {
			// A crashed worker degrades to inline passes; a deliberate dispose propagates.
			if (!this.#workerFailed) throw error;
			return this.#reconcileInline(inline);
		}
		if (response === undefined) return { complete: false };
		if (response.type === "error") throw new Error(`session search indexing failed: ${response.error}`);
		return { complete: response.type === "result" && response.complete };
	}

	#reconcileInline(opts: ReconcileOptions): { complete: boolean } {
		const db = openSessionSearchDb();
		if (!db) return { complete: false };
		return { complete: reconcile(db, { ...opts, budgetMs: Math.min(opts.budgetMs, INLINE_BUDGET_MS) }).complete };
	}

	/** Round-trip a ping; throws when the worker is unavailable or silent. */
	async ping(timeoutMs: number): Promise<void> {
		if (!this.#ensureWorker()) throw new Error("session search worker unavailable");
		const response = await this.#request({ type: "ping", id: this.#nextId++ }, timeoutMs);
		if (response?.type !== "pong") throw new Error("session search worker did not answer ping");
	}

	#ensureWorker(): Worker | undefined {
		if (this.#worker) return this.#worker;
		if (this.#workerFailed) return undefined;
		try {
			const hostEntry = workerHostEntry();
			const worker = hostEntry
				? new Worker(hostEntry, { type: "module", argv: [SESSION_SEARCH_WORKER_ARG] })
				: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
			worker.addEventListener("message", (event: MessageEvent<SessionSearchWorkerResponse>) => {
				const pending = this.#pending.get(event.data.id);
				if (!pending) return;
				this.#pending.delete(event.data.id);
				pending.resolve(event.data);
				this.#settleIdle();
			});
			worker.addEventListener("error", (event: ErrorEvent) => {
				logger.warn("Session search worker failed; indexing inline", { error: event.message });
				this.#workerFailed = true;
				if (this.#worker === worker) this.#worker = undefined;
				this.#failAll(new Error(`session search worker failed: ${event.message}`));
				worker.terminate();
			});
			worker.addEventListener("close", () => {
				if (this.#worker === worker) this.#worker = undefined;
				this.#failAll(new Error("session search worker exited"));
			});
			worker.unref();
			this.#worker = worker;
			return worker;
		} catch (error) {
			logger.warn("Session search worker unavailable; indexing inline", { error: String(error) });
			this.#workerFailed = true;
			return undefined;
		}
	}

	/** Post a request; resolves undefined when no response arrives within `timeoutMs`. */
	async #request(
		request: SessionSearchWorkerRequest,
		timeoutMs: number,
	): Promise<SessionSearchWorkerResponse | undefined> {
		const worker = this.#worker;
		if (!worker) throw new Error("session search worker unavailable");
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const { promise, resolve, reject } = Promise.withResolvers<SessionSearchWorkerResponse | undefined>();
		const timer = setTimeout(() => {
			this.#pending.delete(request.id);
			logger.debug("Session search worker response timed out", { type: request.type, timeoutMs });
			resolve(undefined);
			this.#settleIdle();
		}, timeoutMs);
		this.#pending.set(request.id, {
			resolve: response => {
				clearTimeout(timer);
				resolve(response);
			},
			reject: error => {
				clearTimeout(timer);
				reject(error);
			},
		});
		worker.ref();
		worker.postMessage(request);
		return promise;
	}

	#settleIdle(): void {
		if (this.#pending.size > 0 || !this.#worker) return;
		this.#worker.unref();
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => this.#terminate(), IDLE_TERMINATE_MS);
		this.#idleTimer.unref();
	}

	#failAll(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const request of pending) request.reject(error);
	}

	#terminate(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const worker = this.#worker;
		this.#worker = undefined;
		this.#failAll(new Error("session search worker terminated"));
		worker?.terminate();
	}
}

/** Distribution smoke: the worker loads through the CLI host and answers a ping. */
export async function smokeTestSessionSearchWorker(): Promise<void> {
	const client = new SessionSearchIndexClient();
	try {
		await client.ping(5_000);
	} finally {
		client.dispose();
	}
}
