import { Lexer, type Token, type Tokens } from "marked";

export type TelegramTextStyle = "markdown" | "plain" | "pc";
export interface TelegramText {
	text: string;
	plainText: string;
}

type Style = "bold" | "italic" | "strike" | "code" | "pre" | "link" | "quote";
interface Span {
	start: number;
	end: number;
	style: Style;
	argument?: string;
}
interface Document {
	text: string;
	spans: Span[];
}

const MAX_LENGTH = 4096;
const escapeText = (text: string): string => text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
const escapeCode = (text: string): string => text.replace(/[`\\]/g, "\\$&");
const escapeUrl = (text: string): string => text.replace(/[)\\]/g, "\\$&");

function markdownDocument(source: string): Document {
	const doc: Document = { text: "", spans: [] };
	const append = (text: string): void => { doc.text += text; };
	const styled = (style: Style, render: () => void, argument?: string): void => {
		const start = doc.text.length;
		render();
		if (doc.text.length > start) doc.spans.push({ start, end: doc.text.length, style, argument });
	};

	function inline(tokens: Token[]): void {
		for (const token of tokens) {
			switch (token.type) {
				case "strong":
				case "em":
				case "del": {
					const style = token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strike";
					styled(style, () => inline((token as Tokens.Strong).tokens));
					break;
				}
				case "codespan":
					styled("code", () => append((token as Tokens.Codespan).text));
					break;
				case "link": {
					const link = token as Tokens.Link;
					if (/^(https?:|mailto:|tg:)/i.test(link.href) && !/[\s\x00-\x1f]/.test(link.href)) {
						styled("link", () => inline(link.tokens), link.href);
					} else {
						inline(link.tokens);
					}
					break;
				}
				case "image": {
					const image = token as Tokens.Image;
					append(`[Image: ${image.text}] (${image.href})`);
					break;
				}
				case "checkbox":
					break;
				case "br":
					append("\n");
					break;
				case "paragraph":
				case "text": {
					const text = token as Tokens.Text;
					if (text.tokens) inline(text.tokens);
					else append(text.text);
					break;
				}
				default:
					append("text" in token ? String(token.text) : token.raw);
			}
		}
	}

	function blocks(tokens: Token[], depth = 0): void {
		let first = true;
		for (const token of tokens) {
			if (token.type === "space" || token.type === "def" || token.type === "checkbox") continue;
			if (!first) append("\n\n");
			first = false;
			switch (token.type) {
				case "heading":
					styled("bold", () => inline((token as Tokens.Heading).tokens));
					break;
				case "paragraph":
				case "text":
					inline([token]);
					break;
				case "code": {
					const code = token as Tokens.Code;
					const language = code.lang?.split(/\s/)[0] ?? "";
					styled("pre", () => append(code.text), /^[\w+-]{1,32}$/.test(language) ? language : "");
					break;
				}
				case "blockquote":
					styled("quote", () => blocks((token as Tokens.Blockquote).tokens, depth));
					break;
				case "list": {
					const list = token as Tokens.List;
					list.items.forEach((item, index) => {
						if (index > 0) append("\n");
						const bullet = item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${Number(list.start) + index}.` : "•";
						append(`${"  ".repeat(depth)}${bullet} `);
						blocks(item.tokens, depth + 1);
					});
					break;
				}
				case "table": {
					const table = token as Tokens.Table;
					const rows = [table.header, ...table.rows].map((row) => row.map((cell) => cell.text).join(" | "));
					styled("pre", () => append(rows.join("\n")));
					break;
				}
				case "hr":
					append("────────");
					break;
				default:
					append("text" in token ? String(token.text) : token.raw);
			}
		}
	}

	blocks(Lexer.lex(source, { gfm: true }));
	return doc;
}

function delimiters(span: Span): [string, string] {
	switch (span.style) {
		case "bold": return ["*", "*"];
		case "italic": return ["_", "_"];
		case "strike": return ["~", "~"];
		case "code": return ["`", "`"];
		case "pre": return [`\`\`\`${span.argument ?? ""}\n`, "```"];
		case "link": return ["[", `](${escapeUrl(span.argument ?? "")})`];
		case "quote": return [">", ""];
	}
}

function serialize(doc: Document, start: number, end: number): string {
	const spans = doc.spans.filter((span) => span.start < end && span.end > start);
	const points = [...new Set([start, end, ...spans.flatMap((span) => [Math.max(start, span.start), Math.min(end, span.end)])])].sort((a, b) => a - b);
	let active: Span[] = [];
	let result = "";
	const key = (span: Span): string => `${span.style}:${span.argument ?? ""}`;
	for (let i = 0; i < points.length - 1; i++) {
		const offset = points[i];
		let next = spans.filter((span) => span.start <= offset && span.end > offset)
			.sort((a, b) => a.start - b.start || b.end - a.end);
		const quote = next.find((span) => span.style === "quote");
		const code = next.find((span) => span.style === "pre" || span.style === "code");
		// Telegram forbids most entity nesting; code is literal, and quotes may contain text styles only.
		if (quote) next = [quote, ...next.filter((span) => ["bold", "italic", "strike"].includes(span.style))];
		else if (code) next = [code];
		next = next.filter((span, index) => next.findIndex((candidate) => key(candidate) === key(span)) === index);
		let shared = 0;
		while (shared < active.length && shared < next.length && key(active[shared]) === key(next[shared])) shared++;
		for (let j = active.length - 1; j >= shared; j--) result += delimiters(active[j])[1];
		for (let j = shared; j < next.length; j++) result += delimiters(next[j])[0];
		const text = doc.text.slice(offset, points[i + 1]);
		result += quote ? escapeText(text).replace(/\n/g, "\n>") : code ? escapeCode(text) : escapeText(text);
		active = next;
	}
	for (let i = active.length - 1; i >= 0; i--) result += delimiters(active[i])[1];
	return result;
}

export function formatTelegramText(source: string, style: TelegramTextStyle = "markdown"): TelegramText[] {
	const doc = style === "markdown" ? markdownDocument(source) : { text: source, spans: [] as Span[] };
	if (!doc.text && source) doc.text = source;
	if (style === "pc") {
		const end = source.indexOf("\n");
		doc.spans.push({ start: 0, end: end < 0 ? source.length : end, style: "bold" });
		if (end >= 0) doc.spans.push({ start: end + 2, end: source.length, style: "quote" });
	}
	const messages: TelegramText[] = [];
	for (let start = 0; start < doc.text.length;) {
		let end = Math.min(start + MAX_LENGTH, doc.text.length);
		if (end < doc.text.length) {
			const newline = doc.text.lastIndexOf("\n", end - 1);
			if (newline >= start + MAX_LENGTH / 2) end = newline + 1;
			const previous = doc.text.charCodeAt(end - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) end--;
		}
		messages.push({ text: serialize(doc, start, end), plainText: doc.text.slice(start, end) });
		start = end;
	}
	return messages;
}
