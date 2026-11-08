/**
 * Learned collaboration-style profile: one enumerated label per fixed dimension,
 * promoted only after repeated confident judge observations. Only labels from
 * the judge question file are stored, and the injected text comes from a static
 * template, so nothing user-authored reaches the system prompt.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { judgeQuestions } from "@oh-my-pi/pi-ai";
import { isEnoent, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import questionFile from "../prompts/judge/cognitive-style.json" with { type: "json" };
import cognitiveStyleTemplate from "../prompts/system/cognitive-style.md" with { type: "text" };

export const COGNITIVE_STYLE_FILE = "cognitive-style.json";
/** Judge confidence below which an observation is ignored. */
export const STYLE_MIN_CONFIDENCE = 0.6;
/** Consecutive agreeing observations needed to adopt or change a dimension's value. */
export const STYLE_CONFIRMATIONS = 2;

export type StyleDimension = "response_length" | "answer_order" | "autonomy" | "pushback" | "expertise";

export interface StyleDimensionState {
	value?: string;
	pending?: string;
	pendingCount: number;
}

export interface CognitiveStyleProfile {
	version: 1;
	updatedAt: number;
	dimensions: Partial<Record<StyleDimension, StyleDimensionState>>;
}

export interface StyleObservation {
	choice: string;
	confidence: number;
}

/** The judge questions; their criteria keys are the only labels a profile may hold. */
export const STYLE_QUESTIONS = judgeQuestions(questionFile);

export const STYLE_DIMENSIONS: readonly StyleDimension[] = [
	"response_length",
	"answer_order",
	"autonomy",
	"pushback",
	"expertise",
];

const UNCLEAR_LABEL = "unclear";

function isAllowedLabel(dimension: StyleDimension, label: unknown): label is string {
	if (typeof label !== "string" || label === UNCLEAR_LABEL) return false;
	return Object.hasOwn(STYLE_QUESTIONS[dimension].criteria, label);
}

function emptyProfile(): CognitiveStyleProfile {
	return { version: 1, updatedAt: 0, dimensions: {} };
}

export function cognitiveStylePath(agentDir: string): string {
	return path.join(agentDir, COGNITIVE_STYLE_FILE);
}

function sanitizeDimension(dimension: StyleDimension, raw: unknown): StyleDimensionState | undefined {
	if (!isRecord(raw)) return undefined;
	const state: StyleDimensionState = { pendingCount: 0 };
	if (isAllowedLabel(dimension, raw.value)) state.value = raw.value;
	if (isAllowedLabel(dimension, raw.pending)) {
		state.pending = raw.pending;
		const count = raw.pendingCount;
		state.pendingCount = typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 1;
	}
	return state.value === undefined && state.pending === undefined ? undefined : state;
}

export async function loadCognitiveStyleProfile(agentDir: string): Promise<CognitiveStyleProfile> {
	const filePath = cognitiveStylePath(agentDir);
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return emptyProfile();
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		logger.warn("cognitive-style: ignoring malformed profile", { path: filePath });
		return emptyProfile();
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.dimensions)) {
		logger.warn("cognitive-style: ignoring malformed profile", { path: filePath });
		return emptyProfile();
	}
	const profile: CognitiveStyleProfile = {
		version: 1,
		updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
		dimensions: {},
	};
	for (const dimension of STYLE_DIMENSIONS) {
		const state = sanitizeDimension(dimension, parsed.dimensions[dimension]);
		if (state) profile.dimensions[dimension] = state;
	}
	return profile;
}

export async function saveCognitiveStyleProfile(agentDir: string, profile: CognitiveStyleProfile): Promise<void> {
	await Bun.write(cognitiveStylePath(agentDir), `${JSON.stringify(profile, null, "\t")}\n`);
}

export async function resetCognitiveStyleProfile(agentDir: string): Promise<void> {
	await fs.rm(cognitiveStylePath(agentDir), { force: true });
}

/**
 * Folds one round of judge answers into the profile. A label becomes the
 * dimension's value only after {@link STYLE_CONFIRMATIONS} consecutive
 * confident observations; a confirmation of the current value clears any
 * pending challenger.
 */
export function applyStyleObservation(
	profile: CognitiveStyleProfile,
	answers: Partial<Record<StyleDimension, StyleObservation>>,
	now: number,
): { profile: CognitiveStyleProfile; changed: boolean } {
	const dimensions: Partial<Record<StyleDimension, StyleDimensionState>> = {};
	let changed = false;
	for (const dimension of STYLE_DIMENSIONS) {
		const previous = profile.dimensions[dimension];
		const answer = answers[dimension];
		if (
			!answer ||
			answer.choice === UNCLEAR_LABEL ||
			answer.confidence < STYLE_MIN_CONFIDENCE ||
			!isAllowedLabel(dimension, answer.choice)
		) {
			if (previous) dimensions[dimension] = previous;
			continue;
		}
		const next: StyleDimensionState = { ...(previous ?? { pendingCount: 0 }) };
		if (answer.choice === next.value) {
			delete next.pending;
			next.pendingCount = 0;
		} else {
			if (answer.choice === next.pending) {
				next.pendingCount += 1;
			} else {
				next.pending = answer.choice;
				next.pendingCount = 1;
			}
			if (next.pendingCount >= STYLE_CONFIRMATIONS) {
				next.value = answer.choice;
				delete next.pending;
				next.pendingCount = 0;
			}
		}
		if (
			next.value !== previous?.value ||
			next.pending !== previous?.pending ||
			next.pendingCount !== (previous?.pendingCount ?? 0)
		) {
			changed = true;
		}
		dimensions[dimension] = next;
	}
	if (!changed) return { profile, changed: false };
	return { profile: { version: 1, updatedAt: now, dimensions }, changed: true };
}

/** System-prompt section for the learned style; `undefined` when no dimension has a value. */
export function renderCognitiveStyleInstructions(profile: CognitiveStyleProfile): string | undefined {
	const flags: Record<string, boolean> = {};
	let any = false;
	for (const dimension of STYLE_DIMENSIONS) {
		const value = profile.dimensions[dimension]?.value;
		if (value === undefined || !isAllowedLabel(dimension, value)) continue;
		flags[`${dimension}_${value}`] = true;
		any = true;
	}
	return any ? prompt.render(cognitiveStyleTemplate, flags) : undefined;
}
