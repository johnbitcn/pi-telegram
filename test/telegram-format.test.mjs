import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTelegramText } from "../telegram-format.ts";

const one = (text, style) => {
	const messages = formatTelegramText(text, style);
	assert.equal(messages.length, 1);
	return messages[0];
};

test("headings, emphasis, deletion and lists become Telegram MarkdownV2", () => {
	const result = one("# 标题\n\n**粗体**、*斜体*、~~删除~~。\n\n- 第一项\n- 第二项");
	assert.equal(result.text, "*标题*\n\n*粗体*、_斜体_、~删除~。\n\n• 第一项\n• 第二项");
	assert.equal(result.plainText, "标题\n\n粗体、斜体、删除。\n\n• 第一项\n• 第二项");
});

test("all MarkdownV2 reserved characters are escaped in literal text", () => {
	const source = "_*[]()~`>#+-=|{}.!\\";
	assert.equal(one(source, "plain").text, [...source].map((character) => `\\${character}`).join(""));
	assert.equal(one(source, "plain").plainText, source);
});

test("PC headings are bold and every body line is quoted without interpreting user input", () => {
	const source = "🖥️ PC 用户\n\n    **不要加粗** C:\\path\\file.ts _value_\n\n> 原有引用\n```ts\nconst x = 1;\n```";
	const result = one(source, "pc");
	assert.equal(result.text, "*🖥️ PC 用户*\n\n>    \\*\\*不要加粗\\*\\* C:\\\\path\\\\file\\.ts \\_value\\_\n>\n>\\> 原有引用\n>\\`\\`\\`ts\n>const x \\= 1;\n>\\`\\`\\`");
	assert.equal(result.plainText, source);
});

test("long PC messages keep the body quoted across chunks without losing text or emoji", () => {
	const source = "🖥️ PC 用户\n\n" + "段落😀\n\n".repeat(2000);
	const messages = formatTelegramText(source, "pc");
	assert.ok(messages.length > 1);
	assert.ok(messages[0].text.startsWith("*🖥️ PC 用户*\n\n>"));
	assert.ok(messages.slice(1).every((message) => message.text.startsWith(">")));
	assert.equal(messages.map((message) => message.plainText).join(""), source);
	assert.ok(messages.every((message) => message.plainText.length <= 4096 && message.plainText.isWellFormed()));
});

test("inline and fenced code escape only backticks and backslashes", () => {
	assert.equal(one("`a_b[1]`.").text, "`a_b[1]`\\.");
	const result = one("```ts\nconst value = `a\\b`;\n```");
	assert.equal(result.text, "```ts\nconst value = \\`a\\\\b\\`;```");
	assert.equal(result.plainText, "const value = `a\\b`;");
});

test("language hints cannot inject MarkdownV2 delimiters", () => {
	const result = one("```bad`language\ncode\n```");
	assert.ok(!result.text.includes("```bad`language\n"));
});

test("code inside emphasis does not produce forbidden entity nesting", () => {
	assert.equal(one("**粗体 `a_b` 和 *斜体***").text, "*粗体 *`a_b`* 和 _斜体_*");
});

test("links escape closing parentheses without losing their destination", () => {
	assert.equal(one("[文档](https://example.com/a_(b))").text, "[文档](https://example.com/a_(b\\))");
	assert.equal(one("[**文档**](https://example.com)").text, "*[文档](https://example.com)*");
	assert.equal(one("[unsafe](javascript:alert%281%29)").text, "unsafe");
});

test("blockquotes prefix every line and do not nest quote entities", () => {
	assert.equal(one("> **引用**\n> 第二行\n\n后续正文").text, ">*引用*\n>第二行\n\n后续正文");
	assert.equal(one("> 外层\n>\n>> 内层").text, ">外层\n>\n>内层");
});

test("numbered lists and task lists retain their meaning", () => {
	assert.equal(one("3. three\n4. four").text, "3\\. three\n4\\. four");
	assert.equal(one("- [x] done\n- [ ] pending").text, "☑ done\n☐ pending");
});

test("GFM tables become readable fixed-width text rather than unsupported table markup", () => {
	const result = one("| 名称 | 数值 |\n| --- | --- |\n| A | 1 |");
	assert.equal(result.text, "```\n名称 | 数值\nA | 1```");
});

test("unfinished streamed Markdown is safe and code fences are closed", () => {
	assert.equal(one("**未完成").text, "\\*\\*未完成");
	assert.equal(one("[link](https://example.com").text, "\\[link\\]\\([https://example\\.com](https://example.com)");
	assert.equal(one("```js\nconst value = 1;").text, "```js\nconst value = 1;```");
});

test("long bold text and links reopen their formatting in every chunk", () => {
	for (const [source, prefix, suffix] of [
		[`**${"x".repeat(10000)}**`, "*", "*"],
		[`[${"x".repeat(10000)}](https://example.com)`, "[", "](https://example.com)"],
	]) {
		const messages = formatTelegramText(source);
		assert.equal(messages.length, 3);
		assert.equal(messages.map((message) => message.plainText).join(""), "x".repeat(10000));
		for (const message of messages) {
			assert.ok(message.text.startsWith(prefix) && message.text.endsWith(suffix));
			assert.ok(message.plainText.length <= 4096);
		}
	}
});

test("long code blocks are split into independently fenced messages without data loss", () => {
	const code = "const value = `a\\b`;\n".repeat(600);
	const messages = formatTelegramText(`\`\`\`js\n${code}\`\`\``);
	assert.equal(messages.map((message) => message.plainText).join(""), code.replace(/\n$/, ""));
	for (const message of messages) {
		assert.ok(message.text.startsWith("```js\n") && message.text.endsWith("```"));
		assert.ok(message.plainText.length <= 4096);
	}
});

test("long quotes reopen their quote marker in each message", () => {
	const messages = formatTelegramText(`> ${"q".repeat(9000)}`);
	assert.equal(messages.map((message) => message.plainText).join(""), "q".repeat(9000));
	assert.ok(messages.every((message) => message.text.startsWith(">")));
});

test("message limits apply after parsing, and UTF-16 surrogate pairs stay intact", () => {
	const punctuation = formatTelegramText("!".repeat(4096), "plain");
	assert.equal(punctuation.length, 1);
	assert.equal(punctuation[0].text.length, 8192);
	const source = "a".repeat(4095) + "😀".repeat(3000);
	const messages = formatTelegramText(source, "plain");
	assert.equal(messages.map((message) => message.plainText).join(""), source);
	for (const message of messages) {
		assert.ok(message.plainText.length <= 4096);
		assert.ok(message.plainText.isWellFormed());
	}
});

test("literal HTML is not interpreted, empty input is skipped and hidden-only source is retained", () => {
	assert.equal(one("<b>not bold</b>").plainText, "<b>not bold</b>");
	assert.deepEqual(formatTelegramText(""), []);
	assert.equal(one("[ref]: https://example.com").plainText, "[ref]: https://example.com");
});
