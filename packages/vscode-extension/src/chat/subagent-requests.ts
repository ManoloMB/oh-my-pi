/**
 * A subagent's model requests, folded from its session transcript (read
 * incrementally through `get_subagent_messages`) for the chat's request popup.
 * Each assistant message is one request, the unit omp's `requests` counter
 * counts; its tool calls stay `running` until their results reach the transcript.
 */
import type { AgentMessage, AssistantMessage, SubagentRequestView, SubagentToolView } from "../protocol";

/** Harness intent argument omp adds to tool calls (`INTENT_FIELD` in pi-wire). */
const INTENT_FIELD = "i";

function firstLine(text: string): string | undefined {
	return text
		.split("\n")
		.map(line => line.trim())
		.find(Boolean);
}

/** What the call is for: its intent, else its first non-empty text argument. */
function toolLabel(call: { intent?: string; arguments: Record<string, unknown> }): string | undefined {
	const intent = call.intent ?? call.arguments[INTENT_FIELD];
	if (typeof intent === "string" && intent.trim()) return firstLine(intent);
	for (const [key, value] of Object.entries(call.arguments)) {
		if (key !== INTENT_FIELD && typeof value === "string" && value.trim()) return firstLine(value);
	}
	return undefined;
}

export class SubagentRequestLog {
	#requests: SubagentRequestView[] = [];
	#tools = new Map<string, SubagentToolView>();
	/** Transcript bytes consumed so far: the next read's `fromByte`. */
	nextByte = 0;

	/** Forget everything (the transcript was rewritten and is read again from the start). */
	reset(): void {
		this.#requests = [];
		this.#tools.clear();
		this.nextByte = 0;
	}

	append(messages: AgentMessage[]): void {
		for (const message of messages) {
			if (message.role === "assistant") this.#addRequest(message);
			else if (message.role === "toolResult") {
				const tool = this.#tools.get(message.toolCallId);
				if (tool) tool.status = message.isError ? "error" : "done";
			}
		}
	}

	/**
	 * Requests for the popup. A running agent with no tool in flight is waiting
	 * for the model's next answer; once the agent ended, calls still without a
	 * result were interrupted.
	 */
	view(active: boolean): { requests: SubagentRequestView[]; waiting: boolean } {
		const requests = this.#requests.map(request => {
			const tools = request.tools.map(tool =>
				!active && tool.status === "running" ? { ...tool, status: "interrupted" as const } : { ...tool },
			);
			return { ...request, tools, current: active && tools.some(tool => tool.status === "running") };
		});
		return { requests, waiting: active && !requests.some(request => request.current) };
	}

	#addRequest(message: AssistantMessage): void {
		const usage = message.usage;
		let text: string | undefined;
		const tools: SubagentToolView[] = [];
		for (const block of message.content) {
			if (block.type === "text") text ??= firstLine(block.text);
			else if (block.type === "toolCall") {
				const tool: SubagentToolView = { name: block.name, label: toolLabel(block), status: "running" };
				this.#tools.set(block.id, tool);
				tools.push(tool);
			}
		}
		this.#requests.push({
			index: this.#requests.length + 1,
			at: message.timestamp,
			durationMs: message.duration,
			tokens: (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0),
			cost: usage?.cost?.total ?? 0,
			text,
			tools,
			error:
				message.stopReason === "error" || message.stopReason === "aborted"
					? (message.errorMessage ?? (message.stopReason === "aborted" ? "Aborted" : "Provider error"))
					: undefined,
			current: false,
		});
	}
}
