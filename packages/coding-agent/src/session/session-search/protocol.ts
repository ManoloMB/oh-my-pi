/** Messages exchanged with the session-search worker thread. */
export type SessionSearchWorkerRequest =
	| {
			type: "reconcile";
			id: number;
			/** Resolved by the parent so the worker never depends on its own agent-dir state. */
			dbPath: string;
			sessionsRoot: string;
			scopeCwd?: string;
			budgetMs: number;
			indexThinking: boolean;
	  }
	| { type: "ping"; id: number };

export type SessionSearchWorkerResponse =
	| { type: "result"; id: number; complete: boolean; indexedFiles: number }
	| { type: "error"; id: number; error: string }
	| { type: "pong"; id: number };
