import { describe, expect, it } from "bun:test";
import { MAX_EXAMPLE_PROMPT_LENGTH, MAX_EXAMPLE_PROMPTS, normalizeExamplePrompts } from "../src/example-prompts";

describe("normalizeExamplePrompts", () => {
	it("keeps each prompt on one line and drops blanks, repeats and non-strings", () => {
		const saved = normalizeExamplePrompts(["  Revisa\n el  pipeline ", "", "   ", 42, "Revisa el pipeline", "Otro"]);

		expect(saved).toEqual(["Revisa el pipeline", "Otro"]);
	});

	it("caps how many prompts and how long each one is kept", () => {
		const many = Array.from({ length: MAX_EXAMPLE_PROMPTS + 3 }, (_, index) => `prompt ${index}`);
		const long = `${"a".repeat(MAX_EXAMPLE_PROMPT_LENGTH - 1)} b`;

		expect(normalizeExamplePrompts(many)).toEqual(many.slice(0, MAX_EXAMPLE_PROMPTS));
		expect(normalizeExamplePrompts([long])).toEqual(["a".repeat(MAX_EXAMPLE_PROMPT_LENGTH - 1)]);
	});
});
