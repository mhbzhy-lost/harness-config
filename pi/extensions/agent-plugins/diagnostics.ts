/** 诊断与公共判定。放在独立模块，避免 manifest ↔ mcp-config 的循环导入。 */

export interface Diagnostic {
	severity: "error" | "warning";
	message: string;
	path?: string;
}

export function errorOf(message: string, path?: string): Diagnostic {
	return { severity: "error", message, path };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
