/**
 * Background observer that periodically asks the `judge` role chain to classify
 * the user's recent messages along the fixed style dimensions and folds the
 * answers into the persisted profile. Best effort: failures never reach the turn,
 * and the running session's system prompt is not rebuilt (prompt-cache safety).
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { journalJudgmentUsage, resolveJudge } from "../judgment";
import { cfgMemoryCognitiveStyle } from "../memory-backend/settings";
import { redactMemorySecrets } from "../memory-backend/redact";
import type { AgentSession } from "../session/agent-session";
import {
	applyStyleObservation,
	loadCognitiveStyleProfile,
	STYLE_DIMENSIONS,
	STYLE_QUESTIONS,
	type StyleDimension,
	type StyleObservation,
	saveCognitiveStyleProfile,
} from "./profile";

/** New user messages between analyses. */
export const STYLE_ANALYSIS_EVERY = 6;
/** Most recent user messages sent to the judge. */
export const STYLE_ANALYSIS_MESSAGES = 12;
/** Per-message character cap after redaction. */
export const STYLE_MESSAGE_MAX_CHARS = 1200;

const MIN_ANALYSIS_TEXTS = 3;

/** One analysis at a time per process; profiles are global per agent dir. */
let inFlight: Promise<void> | undefined;

function userMessageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const { content } = message;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function analyzeCognitiveStyle(session: AgentSession): Promise<void> {
	try {
		const texts = session.messages
			.filter(message => message.role === "user")
			.slice(-STYLE_ANALYSIS_MESSAGES)
			.map(message => redactMemorySecrets(userMessageText(message)).slice(0, STYLE_MESSAGE_MAX_CHARS))
			.filter(text => text.trim().length > 0);
		if (texts.length < MIN_ANALYSIS_TEXTS) return;
		const judge = resolveJudge({
			settings: session.settings,
			registry: session.modelRegistry,
			sessionModel: session.model,
			sessionId: session.sessionId,
			metadataResolver: provider => session.agent.metadataForProvider(provider),
			purpose: "cognitive-style",
			onUsage: journalJudgmentUsage(session.sessionManager),
			telemetry: session.agent.telemetry,
		});
		const { answers } = await judge.judge({ state: { messages: texts }, questions: STYLE_QUESTIONS });
		const observations: Partial<Record<StyleDimension, StyleObservation>> = {};
		for (const dimension of STYLE_DIMENSIONS) {
			const answer = answers[dimension];
			observations[dimension] = { choice: answer.choice, confidence: answer.confidence };
		}
		const agentDir = session.settings.getAgentDir();
		const { profile, changed } = applyStyleObservation(
			await loadCognitiveStyleProfile(agentDir),
			observations,
			Date.now(),
		);
		if (changed) await saveCognitiveStyleProfile(agentDir, profile);
	} catch (error) {
		logger.debug("cognitive-style: analysis failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Starts observing `session`; returns the unsubscribe. */
export function attachCognitiveStyleObserver(session: AgentSession): () => void {
	const countUserMessages = (): number => session.messages.filter(message => message.role === "user").length;
	// Earlier history of a resumed session is never re-analyzed.
	let baseline = countUserMessages();
	return session.subscribe(event => {
		if (event.type !== "agent_end") return;
		if (!cfgMemoryCognitiveStyle.get(session.settings)) return;
		const count = countUserMessages();
		if (count - baseline < STYLE_ANALYSIS_EVERY || inFlight) return;
		baseline = count;
		inFlight = analyzeCognitiveStyle(session).finally(() => {
			inFlight = undefined;
		});
	});
}
