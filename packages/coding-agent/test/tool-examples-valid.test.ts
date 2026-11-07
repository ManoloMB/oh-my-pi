import { describe, expect, it } from "bun:test";
import { type TSchema, type ToolExample, validateToolArguments } from "@oh-my-pi/pi-ai";
import {
	APPLY_PATCH_EXAMPLES,
	applyPatchSchema,
	PATCH_EXAMPLES,
	patchEditSchema,
	REPLACE_EXAMPLES,
	replaceEditSchema,
} from "@oh-my-pi/pi-coding-agent/edit";
import { BASH_EXAMPLES, bashSchemaBase } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GREP_EXAMPLES, searchSchema } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { FIND_EXAMPLES, findSchema } from "@oh-my-pi/pi-coding-agent/tools/jfind";

// Examples ride every request's tool description; an example the schema rejects teaches the model an invalid call.
const cases: Array<{ name: string; parameters: TSchema; examples: readonly ToolExample[] }> = [
	{ name: "edit (replace)", parameters: replaceEditSchema, examples: REPLACE_EXAMPLES },
	{ name: "edit (patch)", parameters: patchEditSchema, examples: PATCH_EXAMPLES },
	{ name: "edit (apply_patch)", parameters: applyPatchSchema, examples: APPLY_PATCH_EXAMPLES },
	{ name: "grep", parameters: searchSchema, examples: GREP_EXAMPLES },
	{ name: "find", parameters: findSchema, examples: FIND_EXAMPLES },
	{ name: "bash", parameters: bashSchemaBase, examples: BASH_EXAMPLES },
];

describe("tool examples", () => {
	for (const { name, parameters, examples } of cases) {
		it(`${name} examples are valid calls`, () => {
			const calls = examples.flatMap(example =>
				"call" in example ? [example.call] : "good" in example ? [example.bad, example.good] : [],
			);
			expect(calls.length).toBeGreaterThan(0);
			for (const call of calls) {
				const validated = validateToolArguments(
					{ name, description: "", parameters },
					{ type: "toolCall", id: "t", name, arguments: call },
				);
				expect(validated).toEqual(call);
			}
		});
	}
});
