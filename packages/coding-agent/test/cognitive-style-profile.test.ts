import { describe, expect, it } from "bun:test";
import {
	applyStyleObservation,
	type CognitiveStyleProfile,
	cognitiveStylePath,
	loadCognitiveStyleProfile,
	renderCognitiveStyleInstructions,
	resetCognitiveStyleProfile,
	saveCognitiveStyleProfile,
} from "@oh-my-pi/pi-coding-agent/cognitive-style/profile";
import { TempDir } from "@oh-my-pi/pi-utils";

const empty = (): CognitiveStyleProfile => ({ version: 1, updatedAt: 0, dimensions: {} });

describe("cognitive style profile", () => {
	it("adopts a label only after two confident observations", () => {
		const first = applyStyleObservation(empty(), { response_length: { choice: "terse", confidence: 0.9 } }, 10);
		expect(first.changed).toBe(true);
		expect(first.profile.updatedAt).toBe(10);
		expect(first.profile.dimensions.response_length).toEqual({ pending: "terse", pendingCount: 1 });

		const second = applyStyleObservation(
			first.profile,
			{ response_length: { choice: "terse", confidence: 0.8 } },
			20,
		);
		expect(second.changed).toBe(true);
		expect(second.profile.dimensions.response_length?.value).toBe("terse");
		expect(second.profile.dimensions.response_length?.pending).toBeUndefined();
		expect(second.profile.dimensions.response_length?.pendingCount).toBe(0);
	});

	it("ignores unclear answers, low confidence, and unknown labels", () => {
		const profile = empty();
		for (const answer of [
			{ choice: "unclear", confidence: 0.9 },
			{ choice: "terse", confidence: 0.5 },
			{ choice: "verbose-ish", confidence: 0.95 },
		]) {
			const result = applyStyleObservation(profile, { response_length: answer }, 99);
			expect(result.changed).toBe(false);
			expect(result.profile).toBe(profile);
		}
	});

	it("loads a malformed profile file as empty", async () => {
		using dir = TempDir.createSync("@omp-cognitive-style-");
		await Bun.write(cognitiveStylePath(dir.path()), "{not json");
		expect(await loadCognitiveStyleProfile(dir.path())).toEqual(empty());
		await Bun.write(cognitiveStylePath(dir.path()), JSON.stringify({ version: 2, dimensions: {} }));
		expect(await loadCognitiveStyleProfile(dir.path())).toEqual(empty());
	});

	it("round-trips through disk, drops unknown labels, and resets", async () => {
		using dir = TempDir.createSync("@omp-cognitive-style-");
		expect(await loadCognitiveStyleProfile(dir.path())).toEqual(empty());
		await saveCognitiveStyleProfile(dir.path(), {
			version: 1,
			updatedAt: 5,
			dimensions: { autonomy: { value: "act", pendingCount: 0 } },
		});
		await Bun.write(
			cognitiveStylePath(dir.path()),
			JSON.stringify({
				version: 1,
				updatedAt: 5,
				dimensions: {
					autonomy: { value: "act", pendingCount: 0 },
					expertise: { value: "wizard", pendingCount: 0 },
				},
			}),
		);
		const loaded = await loadCognitiveStyleProfile(dir.path());
		expect(loaded.dimensions).toEqual({ autonomy: { value: "act", pendingCount: 0 } });
		await resetCognitiveStyleProfile(dir.path());
		expect(await loadCognitiveStyleProfile(dir.path())).toEqual(empty());
	});

	it("renders instructions only for learned values", () => {
		expect(renderCognitiveStyleInstructions(empty())).toBeUndefined();
		expect(
			renderCognitiveStyleInstructions({
				version: 1,
				updatedAt: 1,
				dimensions: { response_length: { pending: "terse", pendingCount: 1 } },
			}),
		).toBeUndefined();
		const rendered = renderCognitiveStyleInstructions({
			version: 1,
			updatedAt: 1,
			dimensions: { response_length: { value: "terse", pendingCount: 0 } },
		});
		expect(rendered).toContain("# User collaboration style");
		expect(rendered).toContain("Keep answers short");
		expect(rendered).not.toContain("Give thorough answers");
	});
});
