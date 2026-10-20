/** Optional identity recorded when a synthetic MCP row is emitted. No name is inferred from a tool string. */
export type McpDisplay = { appName?: string; connectorId?: string; pluginId?: string };

export function mcpDisplayMetadata(value: unknown): McpDisplay | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: McpDisplay = {};
	for (const key of ["appName", "connectorId", "pluginId"] as const) {
		const field = (value as Record<string, unknown>)[key];
		if (field === undefined) continue;
		if (typeof field !== "string" || !field) return undefined;
		out[key] = field;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Identity text is literal terminal text, including control and directional characters. Raw identity stays untouched. */
export function literalMcpLabel(value: string): string {
	return value.replace(/[\\\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (ch) => {
		if (ch === "\\") return "\\\\";
		if (ch === "\n") return "\\n";
		if (ch === "\r") return "\\r";
		if (ch === "\t") return "\\t";
		return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}
