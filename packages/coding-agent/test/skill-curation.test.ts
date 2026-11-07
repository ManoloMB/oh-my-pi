import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { isSelfImprovableSkill, type Skill } from "../src/extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../src/session/messages";
import { listSkillHistory, revertSkillHistoryEntry, writeSkillHistoryEntry } from "../src/skill-curation/history";
import {
	approveSkillProposal,
	listSkillProposals,
	rejectSkillProposal,
	writeSkillProposal,
} from "../src/skill-curation/proposals";
import { collectCurationSignals, renderTaskTranscript, skillAnchors } from "../src/skill-curation/signals";
import { SkillEditTool } from "../src/skill-curation/skill-edit-tool";
import curationTemplate from "../src/prompts/skills/curation.md" with { type: "text" };

const SKILL_FILE = `---
name: demo
description: Lists the demo folder. Use when the user asks what is in the demo folder.
---

# Demo

To list the demo folder run: \`ls --long-format demo\`
`;

let root = "";

function skillAt(name: string, provider = "native"): Skill {
	const baseDir = path.join(root, "skills", name);
	return {
		name,
		description: "Lists the demo folder.",
		filePath: path.join(baseDir, "SKILL.md"),
		baseDir,
		source: `${provider}:project`,
		_source: { provider, providerName: provider, path: path.join(baseDir, "SKILL.md"), level: "project" },
	};
}

function readCall(id: string, target: string): AgentMessage {
	return toolCall(id, "read", { path: target });
}

function bashCall(id: string, command: string): AgentMessage {
	return toolCall(id, "bash", { command });
}

function toolCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(toolCallId: string, isError: boolean): AgentMessage {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [], isError, timestamp: 0 };
}

beforeEach(async () => {
	root = path.join(os.tmpdir(), "omp-skill-curation", Snowflake.next());
	await Bun.write(path.join(root, "skills", "demo", "SKILL.md"), SKILL_FILE);
	await Bun.write(path.join(root, "skills", "demo", "ref.md"), "reference\n");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const NO_ANCHORS = new Map();

describe("collectCurationSignals", () => {
	it("reviews a task that read a skill even when no tool failed, and flags a late read", () => {
		const demo = skillAt("demo");
		const clean = collectCurationSignals(
			[
				readCall("r1", "skill://demo"),
				toolResult("r1", false),
				bashCall("b1", "ls -l demo"),
				toolResult("b1", false),
			],
			0,
			[demo],
			root,
			NO_ANCHORS,
		);
		expect(clean).toEqual({
			candidates: [{ skill: demo, uses: ["read"], matched: [], readLate: false, earlier: false }],
			errorCount: 0,
		});

		const lateRead = collectCurationSignals(
			[toolResult("b1", true), readCall("r1", path.join(demo.baseDir, "SKILL.md:1-5")), toolResult("r1", false)],
			0,
			[demo],
			root,
			NO_ANCHORS,
		);
		expect(lateRead?.candidates[0]).toMatchObject({ readLate: true, earlier: false });
	});

	it("reviews a later task that runs a command the loaded skill documents, and only that kind of task", () => {
		const demo = skillAt("demo");
		const anchors = new Map([
			[demo, skillAnchors("---\nname: demo\n---\n```bash\nexport A=1 && kubectl get ns | grep x\n```\n")],
		]);
		const earlierTask = [readCall("r1", "skill://demo"), toolResult("r1", false)];
		const related = collectCurationSignals(
			[...earlierTask, bashCall("b1", "kubectl get pods -n x"), toolResult("b1", false)],
			earlierTask.length,
			[demo],
			root,
			anchors,
		);
		expect(related?.candidates).toEqual([
			{ skill: demo, uses: ["commands"], matched: ["`kubectl`"], readLate: false, earlier: true },
		]);
		expect(
			collectCurationSignals(
				[...earlierTask, bashCall("b1", "ls -la"), toolResult("b1", true)],
				earlierTask.length,
				[demo],
				root,
				anchors,
			),
		).toBeUndefined();
	});

	it("sees a script of the skill in a command however its path is spelled", () => {
		const windows: Skill = { ...skillAt("demo"), baseDir: "C:\\Users\\me\\.claude\\skills\\demo" };
		const earlierTask = [readCall("r1", "skill://demo"), toolResult("r1", false)];
		const signals = collectCurationSignals(
			[
				...earlierTask,
				bashCall("b1", "py /c/Users/me/.claude/skills/demo/scripts/run.py --dry"),
				toolResult("b1", false),
			],
			earlierTask.length,
			[windows],
			root,
			NO_ANCHORS,
		);
		expect(signals?.candidates[0]?.uses).toEqual(["scripts"]);
	});

	it("ignores skills never loaded, and does not count a failed read of the skill as a task failure", () => {
		const demo = skillAt("demo");
		expect(
			collectCurationSignals([readCall("r1", "skill://other"), toolResult("b1", true)], 0, [demo], root, NO_ANCHORS),
		).toBeUndefined();
		expect(
			collectCurationSignals([readCall("r1", "skill://demo"), toolResult("r1", true)], 0, [demo], root, NO_ANCHORS)
				?.errorCount,
		).toBe(0);
	});

	it("counts every skill of a /skill: invocation as use, not only the first", () => {
		const demo = skillAt("demo");
		const other = skillAt("other");
		const invoked: AgentMessage = {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "body",
			display: true,
			details: {
				name: "demo",
				path: demo.filePath,
				skills: [
					{ name: "demo", path: demo.filePath },
					{ name: "other", path: other.filePath },
				],
			},
			attribution: "user",
			timestamp: 0,
		};
		const candidates = collectCurationSignals([invoked], 0, [demo, other], root, NO_ANCHORS)?.candidates;
		expect(candidates?.map(candidate => [candidate.skill.name, candidate.uses])).toEqual([
			["demo", ["invoked"]],
			["other", ["invoked"]],
		]);
	});
});

describe("skillAnchors", () => {
	it("takes the programs a skill's shell code runs and the hosts it names, without generic utilities", () => {
		const anchors = skillAnchors(
			[
				"---",
				"name: demo",
				"---",
				"Deploy with `gcloud run deploy api`.",
				"```console",
				"$ sudo FOO=1 /usr/bin/terraform plan",
				"```",
				"Docs: https://api.example.com/v1",
			].join("\n"),
		);
		expect([...anchors.commands].sort()).toEqual(["gcloud", "terraform"]);
		expect([...anchors.hosts]).toEqual(["api.example.com"]);
	});
});

describe("isSelfImprovableSkill", () => {
	it("edits other tools' skill folders only when third-party improvement is on; never plugin or registry skills", () => {
		expect(isSelfImprovableSkill(skillAt("demo", "native"), false)).toBe(true);
		expect(isSelfImprovableSkill(skillAt("demo", "claude"), false)).toBe(false);
		expect(isSelfImprovableSkill(skillAt("demo", "claude"), true)).toBe(true);
		expect(isSelfImprovableSkill(skillAt("demo", "claude-plugins"), true)).toBe(false);
		expect(isSelfImprovableSkill(skillAt("demo", "skillshare"), true)).toBe(false);
	});
});

describe("renderTaskTranscript", () => {
	it("keeps every call and result whole, in order, and leaves out the assistant's thinking", () => {
		const longOutput = `${"x".repeat(50_000)} ls: unrecognized option '--long-format'`;
		const failed: AgentMessage = {
			role: "toolResult",
			toolCallId: "b1",
			toolName: "bash",
			content: [{ type: "text", text: longOutput }],
			isError: true,
			timestamp: 0,
		};
		const call = readCall("r1", "skill://demo");
		if (call.role === "assistant") call.content.unshift({ type: "thinking", thinking: "private reasoning" });
		const transcript = renderTaskTranscript([
			{ role: "user", content: "list the demo folder", timestamp: 0 },
			call,
			failed,
		]);
		expect(transcript).toBe(
			`USER: list the demo folder\nCALL read: {"path":"skill://demo"}\nERROR bash: ${longOutput}`,
		);
	});
});

describe("SkillEditTool", () => {
	const edit = (tool: SkillEditTool, params: Partial<Parameters<SkillEditTool["execute"]>[1]>) =>
		tool.execute("call", {
			skill: "demo",
			old_text: "ls --long-format demo",
			new_text: "ls -l demo",
			summary: "Uses ls -l to list the demo folder",
			reason: "ls rejected --long-format; ls -l listed the folder",
			...params,
		});

	it("stages replacements without touching disk, each building on the previous one", async () => {
		const demo = skillAt("demo");
		const tool = new SkillEditTool([demo]);
		expect((await edit(tool, {})).isError).toBeUndefined();
		expect((await edit(tool, { old_text: "ls -l demo", new_text: "ls -la demo" })).isError).toBeUndefined();
		expect(await Bun.file(demo.filePath).text()).toBe(SKILL_FILE);
		const record = tool.edits.get("demo");
		const file = record?.files.get(demo.filePath);
		expect(file?.before).toBe(SKILL_FILE);
		expect(file?.after).toBe(SKILL_FILE.replace("ls --long-format demo", "ls -la demo"));
		expect(record?.reasons).toHaveLength(2);
	});

	it("keeps every edit of one file when the calls arrive concurrently", async () => {
		const demo = skillAt("demo");
		const tool = new SkillEditTool([demo]);
		// Models send several edits in one message; both must land on the staged file.
		const results = await Promise.all([
			edit(tool, {}),
			edit(tool, { old_text: "# Demo", new_text: "# Demo folder" }),
		]);
		expect(results.map(result => result.isError)).toEqual([undefined, undefined]);
		expect(tool.edits.get("demo")?.files.get(demo.filePath)?.after).toBe(
			SKILL_FILE.replace("ls --long-format demo", "ls -l demo").replace("# Demo", "# Demo folder"),
		);
	});

	it("rewrites a whole file when old_text is omitted, still guarding the frontmatter", async () => {
		const demo = skillAt("demo");
		const tool = new SkillEditTool([demo]);
		const rewritten = SKILL_FILE.replace("ls --long-format demo", "ls -l demo").concat(
			"\nVerify with `ls -l demo`.\n",
		);
		const staged = await edit(tool, { old_text: undefined, new_text: rewritten });
		expect(staged.isError).toBeUndefined();
		expect(staged.content[0]).toMatchObject({ text: expect.stringContaining("8 → 10 lines (+2)") });
		// A later edit of the same file reports its change against the file before the first edit.
		const trimmed = await edit(tool, { old_text: "\nVerify with `ls -l demo`.\n", new_text: "" });
		expect(trimmed.content[0]).toMatchObject({ text: expect.stringContaining("8 → 8 lines (±0)") });
		expect((await edit(tool, { old_text: undefined, new_text: rewritten })).isError).toBeUndefined();
		expect(tool.edits.get("demo")?.files.get(demo.filePath)?.after).toBe(rewritten);
		const renamed = await edit(tool, { old_text: undefined, new_text: rewritten.replace("name: demo", "name: x") });
		expect(renamed.isError).toBe(true);
		expect(tool.edits.get("demo")?.files.get(demo.filePath)?.after).toBe(rewritten);
	});

	it("rejects ambiguous text, escapes, frontmatter damage and unknown skills without writing", async () => {
		const demo = skillAt("demo");
		const tool = new SkillEditTool([demo]);
		const cases: Array<[Partial<Parameters<SkillEditTool["execute"]>[1]>, string]> = [
			[{ old_text: "demo" }, "occurs"],
			[{ file: "../escape.md" }, "inside the skill directory"],
			[{ old_text: "name: demo", new_text: "name: renamed" }, "name must not change"],
			[
				{
					old_text: "description: Lists the demo folder.",
					new_text: `description: ${"x".repeat(1100)}`,
				},
				"limit is 1024",
			],
			[{ skill: "other" }, "Editable skills: demo"],
			[{ reason: "  " }, "reason must be non-empty"],
		];
		for (const [params, message] of cases) {
			const result = await edit(tool, params);
			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(message) });
		}
		expect(await Bun.file(demo.filePath).text()).toBe(SKILL_FILE);
		expect(tool.edits.size).toBe(0);
	});
});

describe("skill history", () => {
	it("reverts an edit once, and refuses when the file changed since", async () => {
		const agentDir = path.join(root, "agent");
		const demo = skillAt("demo");
		const after = SKILL_FILE.replace("ls --long-format demo", "ls -l demo");
		await Bun.write(demo.filePath, after);
		const files = [{ path: demo.filePath, relativePath: "SKILL.md", before: SKILL_FILE, after }];

		const entry = await writeSkillHistoryEntry({ skill: "demo", summary: "Uses ls -l", files }, agentDir);
		const [listed] = await listSkillHistory({ skill: "demo" }, agentDir);
		expect(listed.id).toBe(entry.id);
		expect(listed.diff).toContain("- To list the demo folder run: `ls --long-format demo`");
		expect(listed.diff).toContain("+ To list the demo folder run: `ls -l demo`");

		await revertSkillHistoryEntry(entry.id, agentDir);
		expect(await Bun.file(demo.filePath).text()).toBe(SKILL_FILE);
		await expect(revertSkillHistoryEntry(entry.id, agentDir)).rejects.toThrow("already reverted");

		await Bun.write(demo.filePath, after);
		const second = await writeSkillHistoryEntry({ skill: "demo", summary: "Uses ls -l", files }, agentDir);
		await Bun.write(demo.filePath, `${after}\nEdited by hand.\n`);
		await expect(revertSkillHistoryEntry(second.id, agentDir)).rejects.toThrow("changed since the update: SKILL.md");
		expect(await Bun.file(demo.filePath).text()).toBe(`${after}\nEdited by hand.\n`);
	});
});

describe("skill proposals", () => {
	const after = SKILL_FILE.replace("ls --long-format demo", "ls -l demo");

	it("applies an approved proposal once, recording it in the skill history", async () => {
		const agentDir = path.join(root, "agent");
		const demo = skillAt("demo");
		const files = [{ path: demo.filePath, relativePath: "SKILL.md", before: SKILL_FILE, after }];
		const proposal = await writeSkillProposal({ skill: "demo", summary: "Uses ls -l", reason: "r", files }, agentDir);
		const [listed] = await listSkillProposals({}, agentDir);
		expect(listed).toMatchObject({ id: proposal.id, status: "pending", stale: false });
		expect(listed.diff).toContain("+ To list the demo folder run: `ls -l demo`");

		const { history } = await approveSkillProposal(proposal.id, agentDir);
		expect(await Bun.file(demo.filePath).text()).toBe(after);
		expect((await listSkillHistory({ skill: "demo" }, agentDir)).map(entry => entry.id)).toEqual([history.id]);
		expect(await listSkillProposals({}, agentDir)).toEqual([]);
		await expect(approveSkillProposal(proposal.id, agentDir)).rejects.toThrow("already approved");
	});

	it("refuses an outdated proposal without writing, and lets it be rejected with a reason", async () => {
		const agentDir = path.join(root, "agent");
		const demo = skillAt("demo");
		const files = [{ path: demo.filePath, relativePath: "SKILL.md", before: SKILL_FILE, after }];
		const proposal = await writeSkillProposal({ skill: "demo", summary: "Uses ls -l", reason: "r", files }, agentDir);
		await Bun.write(demo.filePath, `${SKILL_FILE}\nEdited by hand.\n`);
		expect((await listSkillProposals({}, agentDir))[0]?.stale).toBe(true);
		await expect(approveSkillProposal(proposal.id, agentDir)).rejects.toThrow("outdated");
		expect(await Bun.file(demo.filePath).text()).toBe(`${SKILL_FILE}\nEdited by hand.\n`);

		await rejectSkillProposal(proposal.id, " not needed ", agentDir);
		expect(await listSkillProposals({}, agentDir)).toEqual([]);
		expect((await listSkillProposals({ status: "all" }, agentDir))[0]).toMatchObject({
			status: "rejected",
			rejectReason: "not needed",
		});
	});

	it("still applies a proposal after another approved one changed other parts of the file", async () => {
		const agentDir = path.join(root, "agent");
		const demo = skillAt("demo");
		// Two curation turns stage edits against the same original skill.
		const stage = async (old_text: string, new_text: string) => {
			const tool = new SkillEditTool([demo]);
			await tool.execute("call", { skill: "demo", old_text, new_text, summary: "s", reason: "r" });
			const files = [...(tool.edits.get("demo")?.files ?? [])].map(([filePath, file]) => ({
				path: filePath,
				...file,
			}));
			return writeSkillProposal({ skill: "demo", summary: "s", reason: "r", files }, agentDir);
		};
		const command = await stage("ls --long-format demo", "ls -l demo");
		const heading = await stage("# Demo", "# Demo folder");
		const clash = await stage("To list the demo folder run", "List the demo folder with");

		await approveSkillProposal(command.id, agentDir);
		const listed = await listSkillProposals({}, agentDir);
		expect(listed.find(p => p.id === heading.id)?.stale).toBe(false);
		expect(listed.find(p => p.id === clash.id)?.stale).toBe(false);

		const { history } = await approveSkillProposal(heading.id, agentDir);
		const both = SKILL_FILE.replace("ls --long-format demo", "ls -l demo").replace("# Demo", "# Demo folder");
		expect(await Bun.file(demo.filePath).text()).toBe(both);
		// The history records the file as it really was, so the revert undoes only this proposal.
		await revertSkillHistoryEntry(history.id, agentDir);
		expect(await Bun.file(demo.filePath).text()).toBe(SKILL_FILE.replace("ls --long-format demo", "ls -l demo"));

		// A replacement whose text another change rewrote no longer applies.
		await Bun.write(demo.filePath, "---\nname: demo\ndescription: d\n---\n\nRun `ls -l demo`.\n");
		await expect(approveSkillProposal(clash.id, agentDir)).rejects.toThrow("outdated");
	});

	it("creates and deletes skill files on approval, and reverting restores both", async () => {
		const agentDir = path.join(root, "agent");
		const demo = skillAt("demo");
		const reference = path.join(demo.baseDir, "reference.md");
		await Bun.write(reference, "Old notes.\n");
		const tool = new SkillEditTool([demo]);
		const common = { skill: "demo", summary: "Lists through a script", reason: "r" };
		const created = await tool.execute("a", {
			...common,
			file: "scripts/list.sh",
			new_text: "#!/bin/sh\nls -l demo\n",
		});
		expect(created.isError).toBeUndefined();
		expect((await tool.execute("b", { ...common, file: "reference.md", delete: true })).isError).toBeUndefined();
		expect((await tool.execute("c", { ...common, delete: true })).isError).toBe(true);
		expect((await tool.execute("d", { ...common, file: "missing.md", old_text: "x", new_text: "y" })).isError).toBe(
			true,
		);

		const files = [...(tool.edits.get("demo")?.files ?? [])].map(([filePath, file]) => ({ path: filePath, ...file }));
		const proposal = await writeSkillProposal({ ...common, files }, agentDir);
		const [listed] = await listSkillProposals({}, agentDir);
		expect(listed.stale).toBe(false);
		expect(listed.diff).toContain("--- scripts/list.sh (new file)");
		expect(listed.diff).toContain("--- reference.md (deleted)");

		const { history } = await approveSkillProposal(proposal.id, agentDir);
		const script = path.join(demo.baseDir, "scripts", "list.sh");
		expect(await Bun.file(script).text()).toBe("#!/bin/sh\nls -l demo\n");
		expect((await fs.stat(script)).mode & 0o111).not.toBe(0);
		expect(await Bun.file(reference).exists()).toBe(false);

		await revertSkillHistoryEntry(history.id, agentDir);
		expect(await Bun.file(script).exists()).toBe(false);
		expect(await Bun.file(reference).text()).toBe("Old notes.\n");
	});
});

describe("curation prompt", () => {
	it("shows pending and rejected proposals and asks for silent missteps when nothing failed", () => {
		const text = prompt.render(curationTemplate, {
			transcript: "USER: hi",
			errorCount: 0,
			skills: [
				{
					name: "demo",
					filePath: "/s/demo/SKILL.md",
					content: SKILL_FILE,
					used: "read",
					pending: [{ summary: "Uses ls -l", diff: "--- SKILL.md\n+ x" }],
					rejected: [{ summary: "Adds a note", reason: "not needed" }],
					hasPending: true,
					hasRejected: true,
				},
			],
		});
		expect(text).toContain('<pending-proposals skill="demo">');
		expect(text).toContain("- Adds a note — reason: not needed");
		expect(text).toContain("No tool call failed");
	});
});
