/**
 * Session-search worker thread: owns its own index connection and runs
 * incremental reconcile passes off the main thread.
 */
import type { Database } from "bun:sqlite";
import { parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { reconcile } from "./indexer";
import type { SessionSearchWorkerRequest, SessionSearchWorkerResponse } from "./protocol";
import { openSessionSearchDbAt } from "./schema";

if (!parentPort) throw new Error("session-search worker: missing parentPort");

const port = parentPort;
let open: { dbPath: string; db: Database } | undefined;

function handle(message: unknown): void {
	const request = message as SessionSearchWorkerRequest;
	let response: SessionSearchWorkerResponse;
	if (request.type === "ping") {
		response = { type: "pong", id: request.id };
	} else {
		try {
			if (open?.dbPath !== request.dbPath) {
				open?.db.close();
				open = { dbPath: request.dbPath, db: openSessionSearchDbAt(request.dbPath) };
			}
			const result = reconcile(open.db, {
				sessionsRoot: request.sessionsRoot,
				scopeCwd: request.scopeCwd,
				budgetMs: request.budgetMs,
				indexThinking: request.indexThinking,
			});
			response = { type: "result", id: request.id, ...result };
		} catch (error) {
			logger.warn("Session search reconcile failed", { error: String(error) });
			response = { type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) };
		}
	}
	port.postMessage(response);
}

const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else port.on("message", handle);
