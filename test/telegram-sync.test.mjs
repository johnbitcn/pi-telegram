import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { after, before, test } from "node:test";

let telegramExtension;
const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;
const home = await mkdtemp(join(tmpdir(), "pi-telegram-test-"));
const configPath = join(home, ".pi", "agent", "telegram.json");

before(async () => {
	process.env.HOME = home;
	// Only tool-schema construction needs this peer dependency; no tool schemas are exercised here.
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@sinclair/typebox") {
				return { url: "data:text/javascript,export const Type = { Object: x => x, Array: x => x, String: x => x };", shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	try {
		telegramExtension = (await import("../index.ts")).default;
	} finally {
		hooks.deregister();
	}
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
});

after(async () => {
	globalThis.fetch = originalFetch;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await rm(home, { recursive: true, force: true });
});

async function bridge(t, { paired = true, drafts = true, formatError } = {}) {
	await writeFile(configPath, JSON.stringify({ botToken: "test-token", lastUpdateId: 0, ...(paired ? { allowedUserId: 42 } : {}) }));
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const calls = [];
	const notifications = [];
	const statuses = [];
	const forwarded = [];
	let messageId = 0;
	let deliverUpdates;
	let failNextSend = false;
	globalThis.fetch = async (url, options) => {
		const method = new URL(url).pathname.split("/").at(-1);
		const body = options.body instanceof FormData ? options.body : JSON.parse(options.body);
		calls.push({ method, body });
		if (method === "getUpdates") {
			return new Promise((resolve, reject) => {
				deliverUpdates = (updates) => resolve(Response.json({ ok: true, result: updates }));
				options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			});
		}
		if (method === "sendMessageDraft" && !drafts) return Response.json({ ok: false, description: "Drafts unsupported" });
		if (formatError && body.parse_mode === "MarkdownV2") return Response.json({ ok: false, ...formatError });
		if (method === "sendMessage" && failNextSend) {
			failNextSend = false;
			throw new Error("Network unavailable");
		}
		return Response.json({ ok: true, result: { message_id: ++messageId } });
	};
	const ctx = {
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (_key, text) => statuses.push(text),
			notify: (message, level) => notifications.push({ message, level }),
		},
		isIdle: () => true,
		abort: async () => {},
	};
	telegramExtension({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		sendUserMessage: (content) => forwarded.push(content),
	});
	const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
	const command = (name, args = "") => commands.get(name).handler(args, ctx);
	t.after(async () => { await emit("session_shutdown"); });
	await emit("session_start");
	return {
		emit, command, calls, notifications, statuses, forwarded, tools,
		texts: () => calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text),
		failSend: () => { failNextSend = true; },
		update: async (text, userId = 42) => {
			for (let i = 0; i < 100 && !deliverUpdates; i++) await setImmediate();
			assert.ok(deliverUpdates, "Long polling started");
			const count = forwarded.length;
			deliverUpdates([{ update_id: 1, message: { message_id: 100, chat: { id: userId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Test" }, text } }]);
			// Wait for the polling loop's file write and queued-message processing.
			for (let i = 0; i < 100; i++) {
				await setImmediate();
				if (forwarded.length > count) return;
			}
			throw new Error("Telegram update was not queued");
		},
	};
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });

async function reply(b, text, extra = {}) {
	const message = assistant(text, extra);
	await b.emit("message_start", { message });
	await b.emit("message_update", { message });
	return message;
}

async function pcTurn(b, prompt = "PC question", answer = "PC answer") {
	await b.emit("before_agent_start", { prompt, systemPrompt: "System" });
	await b.emit("agent_start");
	await b.emit("message_end", { message: user(prompt) });
	const message = await reply(b, answer);
	await b.emit("agent_end", { messages: [message] });
}

test("sync defaults off and requires a connected, paired bridge", async (t) => {
	const b = await bridge(t);
	await pcTurn(b);
	assert.deepEqual(b.texts(), []);
	await b.command("telegram-sync", "on");
	assert.match(b.notifications.at(-1).message, /Connect and pair/);
	await b.command("telegram-connect");
	await pcTurn(b);
	assert.deepEqual(b.texts(), []);
	await b.command("telegram-sync", "unexpected");
	assert.match(b.notifications.at(-1).message, /Usage:/);
});

test("an unpaired bridge cannot enable sync", async (t) => {
	const b = await bridge(t, { paired: false });
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	assert.match(b.notifications.at(-1).message, /Connect and pair/);
	await pcTurn(b);
	assert.deepEqual(b.texts(), []);
});

test("sync sends PC input, intermediate replies and the final reply exactly once", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync");
	await b.emit("agent_start");
	await b.emit("message_end", { message: user("Please check the code") });
	await reply(b, "I will inspect the code.");
	await b.emit("message_start", { message: { role: "toolResult", content: [] } });
	await b.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "private tool output" }] } });
	const final = await reply(b, "The fix is complete.");
	await b.emit("agent_end", { messages: [final] });
	assert.deepEqual(b.texts(), ["*🖥️ PC 用户*\n\n>Please check the code", "I will inspect the code\\.", "The fix is complete\\."]);
	assert.ok(b.calls.filter((call) => call.method === "sendMessage").every((call) => call.body.chat_id === 42));
	assert.deepEqual(b.forwarded, []);
	assert.ok(b.calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).every((call) => call.body.parse_mode === "MarkdownV2"));
	await b.command("telegram-status");
	assert.match(b.notifications.at(-1).message, /conversation sync: on/);
});

test("toggle off and disconnect stop PC synchronization", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await pcTurn(b);
	const count = b.texts().length;
	await b.command("telegram-sync");
	await pcTurn(b);
	assert.equal(b.texts().length, count);
	await b.command("telegram-sync", "on");
	await b.command("telegram-disconnect");
	await pcTurn(b);
	assert.equal(b.texts().length, count);
	await b.command("telegram-connect");
	await pcTurn(b);
	assert.equal(b.texts().length, count);
});

test("switching off during a PC reply cancels remaining previews and final sends", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("agent_start");
	await b.emit("message_end", { message: user("Question") });
	const final = await reply(b, "Not sent yet");
	await b.command("telegram-sync", "off");
	await b.emit("agent_end", { messages: [final] });
	assert.deepEqual(b.texts(), ["*🖥️ PC 用户*\n\n>Question"]);
});

for (const sync of [false, true]) {
	test(`Telegram input is not echoed and its reply still works with sync ${sync ? "on" : "off"}`, async (t) => {
		const b = await bridge(t);
		await b.command("telegram-connect");
		if (sync) await b.command("telegram-sync", "on");
		await b.update("Telegram question");
		await b.emit("before_agent_start", { prompt: "[telegram] Telegram question", systemPrompt: "System" });
		await b.emit("agent_start");
		await b.emit("message_end", { message: user("[telegram] Telegram question") });
		const final = await reply(b, "Telegram answer");
		await b.emit("agent_end", { messages: [final] });
		assert.deepEqual(b.texts(), ["Telegram answer"]);
	});
}

test("long intermediate and final replies are split without losing text", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("agent_start");
	const intermediate = "i".repeat(9000);
	const finalText = "f".repeat(10000);
	await reply(b, intermediate);
	const final = await reply(b, finalText);
	await b.emit("agent_end", { messages: [final] });
	assert.equal(b.texts().join(""), intermediate + finalText);
	assert.ok(b.texts().every((text) => text.length <= 4096));
});

test("unsupported drafts reuse the preview message instead of duplicating it", async (t) => {
	const b = await bridge(t, { drafts: false });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("agent_start");
	await reply(b, "Partial reply");
	t.mock.timers.tick(750);
	await setImmediate();
	const finalText = "Final reply. " + "x".repeat(5000);
	await b.emit("message_update", { message: assistant(finalText) });
	await b.emit("agent_end", { messages: [assistant(finalText)] });
	const edit = b.calls.find((call) => call.method === "editMessageText");
	assert.equal(b.texts()[0], "Partial reply");
	assert.equal(edit.body.text + b.texts().slice(1).join(""), finalText.replace(".", "\\."));
	assert.equal(b.calls.filter((call) => call.method === "editMessageText").length, 1);
	assert.equal(edit.body.parse_mode, "MarkdownV2");
});

test("an in-flight preview finishes before final delivery and draft cleanup", async (t) => {
	const b = await bridge(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("agent_start");
	const fetch = globalThis.fetch;
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	let started = false;
	globalThis.fetch = async (url, options) => {
		if (url.endsWith("/sendMessageDraft") && JSON.parse(options.body).text) {
			started = true;
			await blocked;
		}
		return fetch(url, options);
	};
	await reply(b, "Partial response");
	t.mock.timers.tick(750);
	assert.ok(started);
	await b.emit("message_update", { message: assistant("Complete response") });
	const ending = b.emit("agent_end", { messages: [assistant("Complete response")] });
	await setImmediate();
	assert.deepEqual(b.texts(), [], "Final delivery waits for the pending preview");
	release();
	await ending;
	const drafts = b.calls.filter((call) => call.method === "sendMessageDraft");
	assert.deepEqual(drafts.map((call) => call.body.text), ["Partial response", ""]);
	assert.equal(drafts[0].body.parse_mode, "MarkdownV2");
	assert.deepEqual(b.texts(), ["Complete response"]);
});

test("send failure is reported without rejecting a user's message handler", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	b.failSend();
	await b.emit("message_end", { message: user("Question") });
	assert.match(b.statuses.at(-1), /sync failed: Network unavailable/);
	assert.equal(b.calls.filter((call) => call.method === "sendMessage").length, 1, "Network failures are not retried as plain text");
});

test("PC string content and image-only messages have a visible history entry", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("message_end", { message: { role: "user", content: "Plain string input" } });
	await b.emit("message_end", { message: { role: "user", content: [{ type: "image", data: "private-image", mimeType: "image/png" }] } });
	assert.equal(b.texts()[0], "*🖥️ PC 用户*\n\n>Plain string input");
	assert.match(b.texts()[1], /Image attached on PC/);
	assert.ok(!b.texts()[1].includes("private-image"));
});

test("a Telegram entity parsing error falls back to readable plain text", async (t) => {
	const b = await bridge(t, { formatError: { error_code: 400, description: "Bad Request: can't parse entities: malformed formatting" } });
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await pcTurn(b, "**literal PC text**", "**Formatted answer**");
	const sends = b.calls.filter((call) => call.method === "sendMessage");
	assert.deepEqual(sends.map((call) => [call.body.text, call.body.parse_mode]), [
		["*🖥️ PC 用户*\n\n>\\*\\*literal PC text\\*\\*", "MarkdownV2"],
		["🖥️ PC 用户\n\n**literal PC text**", undefined],
		["*Formatted answer*", "MarkdownV2"],
		["Formatted answer", undefined],
	]);
});

for (const drafts of [true, false]) {
	test(`formatting fallback also works for ${drafts ? "draft previews" : "preview edits"}`, async (t) => {
		const b = await bridge(t, { drafts, formatError: { error_code: 400, description: "Bad Request: can't parse entities" } });
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await b.command("telegram-connect");
		await b.command("telegram-sync", "on");
		await b.emit("agent_start");
		await reply(b, "**Partial**");
		t.mock.timers.tick(750);
		await setImmediate();
		const final = assistant("**Complete**");
		await b.emit("message_update", { message: final });
		await b.emit("agent_end", { messages: [final] });
		const method = drafts ? "sendMessageDraft" : "editMessageText";
		const attempts = b.calls.filter((call) => call.method === method && call.body.text);
		const expected = drafts ? "Partial" : "Complete";
		assert.deepEqual(attempts.map((call) => [call.body.text, call.body.parse_mode]), [
			[`*${expected}*`, "MarkdownV2"],
			[expected, undefined],
		]);
	});
}

test("permission errors do not trigger plain-text retries", async (t) => {
	const b = await bridge(t, { formatError: { error_code: 403, description: "Forbidden: bot was blocked by the user" } });
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("message_end", { message: user("Do not retry") });
	assert.equal(b.calls.filter((call) => call.method === "sendMessage").length, 1);
	assert.match(b.statuses.at(-1), /bot was blocked/);
});

test("aborted turns still deliver their partial text and abort notice", async (t) => {
	const b = await bridge(t);
	await b.command("telegram-connect");
	await b.command("telegram-sync", "on");
	await b.emit("agent_start");
	const final = await reply(b, "Partial response", { stopReason: "aborted" });
	await b.emit("agent_end", { messages: [final] });
	assert.deepEqual(b.texts(), ["Partial response\n\nAborted\\."]);
});
