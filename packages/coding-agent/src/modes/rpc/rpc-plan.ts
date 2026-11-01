/**
 * Plan mode for RPC hosts (`--mode rpc` and `--mode rpc-ui`).
 *
 * Mirrors the headless ACP plan mode: entering sets the session's plan-mode
 * state (read-only planning prompt, plan file) and installs the handler that
 * consumes the agent's `xd://propose` write. The proposal asks the host to
 * approve through the extension UI `select` dialog; approval exits plan mode and
 * points the next turn at the approved plan. Hosts without UI (`--no-ui`)
 * auto-approve so plan mode never strands the agent.
 *
 * Unlike the TUI it does not switch to the `plan` role model, and the plan
 * mode of a session is not restored when the session is reopened.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import { normalizePlanTitle, type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../../plan-mode/plan-autosave";
import planApprovedResultPrompt from "../../prompts/system/plan-approved-result.md" with { type: "text" };
import { listPlanFiles, readPlanFile, resolvePlanFilePath } from "../../plan-mode/plan-files";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import type { AgentSession } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { isMCPToolName } from "../../tools/builtin-names";

const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
export const PLAN_APPROVE_OPTION = "Approve and execute";
export const PLAN_REFINE_OPTION = "Refine plan";
/** Lines of the plan shown in the approval dialog title. */
const PREVIEW_LINES = 12;

/** Wire shape of the session's plan mode (`get_state.planMode`, `set_plan_mode` result). */
export interface RpcPlanModeState {
	enabled: boolean;
	planFilePath: string;
	/** On-disk path of `planFilePath`; absent when no local file backs it. */
	planFile?: string;
}

export type RpcPlanSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "isStreaming"
	| "getPlanModeState"
	| "setPlanModeState"
	| "setPlanProposalHandler"
	| "setPlanReferencePath"
	| "getPlanReferencePath"
	| "getGoalModeState"
	| "getVibeModeState"
	| "getEnabledToolNames"
	| "getMountedXdevToolNames"
	| "hasBuiltInTool"
	| "setActiveToolsByName"
	| "restoreNonMCPToolPresentation"
	| "sendPlanModeContext"
	| "runModeExitTeardown"
	| "abort"
>;

export class RpcPlanController {
	readonly #session: RpcPlanSession;
	/** Approval dialog surface; undefined for `--no-ui` hosts, which auto-approve. */
	readonly #ui: ExtensionUIContext | undefined;
	/** Non-MCP tool presentation before plan mode added `write`; restored on exit. */
	#previousTools: { enabled: string[]; mounted: string[] } | undefined;
	/** Plan mode was entered before in this session (the prompt then reads as a re-entry). */
	#hasEntered = false;

	constructor(session: RpcPlanSession, ui: ExtensionUIContext | undefined) {
		this.#session = session;
		this.#ui = ui;
	}

	/** Current plan mode for `get_state`; null when off. */
	get state(): RpcPlanModeState | null {
		const state = this.#session.getPlanModeState();
		if (!state?.enabled) return null;
		let planFile: string | undefined;
		try {
			planFile = resolvePlanFilePath(state.planFilePath, this.#planFileOptions());
		} catch {
			// An internal URL no local file backs: hosts just cannot open it.
		}
		return { enabled: true, planFilePath: state.planFilePath, ...(planFile ? { planFile } : {}) };
	}

	/** `set_plan_mode`: enter or leave plan mode; idempotent. Returns the resulting state. */
	async set(enabled: boolean): Promise<RpcPlanModeState | null> {
		if (enabled) await this.#enter();
		else await this.#exit({ interruptActiveTurn: true });
		return this.state;
	}

	/**
	 * Leave plan mode, without journaling, once the host replaced the transcript
	 * (new/switch/open): the state lives on the shared `AgentSession`, so it would
	 * otherwise leak into a transcript that never entered plan mode.
	 */
	async resetAfterSessionChange(): Promise<void> {
		await this.#exit({ journal: false });
		this.#hasEntered = false;
	}

	async #enter(): Promise<void> {
		const session = this.#session;
		if (session.getPlanModeState()?.enabled) return;
		if (!cfgPlanEnabled.get(session.settings)) {
			throw new Error("Plan mode is disabled. Enable it in settings (plan.enabled).");
		}
		if (session.getGoalModeState()?.enabled) throw new Error("Exit goal mode first.");
		if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode first.");

		const planFilePath = session.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL;
		const previousTools = session.getEnabledToolNames();
		const previousMounted = session.getMountedXdevToolNames();
		// The plan prompt drafts the plan with `write` and submits it as a `write` to
		// `xd://propose`; only the built-in write keeps plan mode's read-only guard
		// (same rule as InteractiveMode.#enterPlanMode).
		const planTools = session.hasBuiltInTool("write") ? [...new Set([...previousTools, "write"])] : previousTools;

		const previousState = session.getPlanModeState();
		// State lands before the tool partition: Code Mode keeps a direct `write` only while plan mode needs it.
		session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel", reentry: this.#hasEntered });
		try {
			await session.setActiveToolsByName(planTools);
		} catch (error) {
			session.setPlanModeState(previousState);
			throw error;
		}
		this.#previousTools = {
			enabled: previousTools.filter(name => !isMCPToolName(name)),
			mounted: previousMounted.filter(name => !isMCPToolName(name)),
		};
		session.setPlanProposalHandler(title => this.#handleProposal(title));
		if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
		this.#hasEntered = true;
		session.sessionManager.appendModeChange("plan", { planFilePath });
	}

	async #exit(options: { interruptActiveTurn?: boolean; journal?: boolean }): Promise<void> {
		const session = this.#session;
		if (!session.getPlanModeState()?.enabled) return;
		// The plan prompt keeps the agent planning until it proposes: a mid-turn exit
		// aborts the turn so it cannot continue on the restored toolset.
		if (options.interruptActiveTurn && session.isStreaming) {
			await session.runModeExitTeardown(async () => {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				await this.#tearDown(options.journal ?? true);
			});
			return;
		}
		await this.#tearDown(options.journal ?? true);
	}

	async #tearDown(journal: boolean): Promise<void> {
		const session = this.#session;
		session.setPlanProposalHandler(null);
		session.setPlanModeState(undefined);
		const previous = this.#previousTools;
		this.#previousTools = undefined;
		if (previous) await session.restoreNonMCPToolPresentation(previous.enabled, previous.mounted);
		if (journal) session.sessionManager.appendModeChange("none");
	}

	/** Consumes the agent's `xd://propose` write while plan mode is on. */
	async #handleProposal(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		const session = this.#session;
		const state = session.getPlanModeState();
		if (!state?.enabled) throw new ToolError("Plan mode is not active.");
		const {
			planFilePath,
			planContent,
			title: resolvedTitle,
		} = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => readPlanFile(url, this.#planFileOptions()),
			// `local://` plan files, newest first: the fallback when the agent dropped the title.
			listPlanFiles: () => listPlanFiles(this.#planFileOptions()),
		});
		const details: PlanApprovalDetails = { planFilePath, title: resolvedTitle, planExists: true };

		// The state follows the plan under review, so `get_state.planMode.planFile` (which hosts read
		// to show the plan while asking) and, on refinement, the next plan-mode message target it.
		if (state.planFilePath !== planFilePath) session.setPlanModeState({ ...state, planFilePath });
		if (!(await this.#approve(resolvedTitle, planContent))) {
			const normalized = normalizePlanTitle(resolvedTitle).title;
			return {
				content: [
					{
						type: "text",
						text: `Plan refinement requested. Update the plan file, then write ${normalized} to xd://propose again when ready.`,
					},
				],
				details,
			};
		}

		session.setPlanReferencePath(planFilePath);
		await this.#tearDown(true);
		let autosaveFailed = false;
		try {
			await autosaveApprovedPlan({
				settings: session.settings,
				cwd: session.sessionManager.getCwd(),
				title: resolvedTitle,
				planContent,
			});
		} catch (error) {
			logger.warn("Failed to autosave approved plan", { error: String(error) });
			autosaveFailed = true;
		}
		return {
			content: [
				{
					type: "text",
					text: prompt.render(planApprovedResultPrompt, {
						planFilePath,
						autosaveFailed,
						todo: session.getEnabledToolNames().includes("todo"),
					}),
				},
			],
			details: { ...details, approved: true },
		};
	}

	/** True only for an explicit approval; dismissing the dialog refines, so closing it never grants write access. */
	async #approve(title: string, planContent: string): Promise<boolean> {
		if (!this.#ui) return true;
		const lines = planContent.split("\n");
		const preview = lines.slice(0, PREVIEW_LINES).join("\n") + (lines.length > PREVIEW_LINES ? "\n…" : "");
		const choice = await this.#ui.select(`Approve plan "${title}" and start implementation?\n\n${preview}`, [
			{ label: PLAN_APPROVE_OPTION, description: "Leave plan mode and implement the plan" },
			{ label: PLAN_REFINE_OPTION, description: "Stay in plan mode and keep refining" },
		]);
		return choice === PLAN_APPROVE_OPTION;
	}

	#planFileOptions() {
		const manager = this.#session.sessionManager;
		return {
			localProtocolOptions: {
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			},
			cwd: manager.getCwd(),
		};
	}
}
