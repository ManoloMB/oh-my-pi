/** Structured tool failure shared by selector parsing and host tool execution. */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ToolError";
	}

	/** Render error for LLM consumption. Override for custom formatting. */
	render(): string {
		return this.message;
	}
}

/** A session tool called from eval code reported failure; carries its output for `try/catch` handling. */
export class ToolCallError extends ToolError {
	constructor(
		readonly toolName: string,
		message: string,
		readonly text: string,
		readonly details?: unknown,
	) {
		super(message, { toolName });
		this.name = "ToolCallError";
	}
}
