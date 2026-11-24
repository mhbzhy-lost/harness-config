/**
 * Agent Plugins 清单与技能发现（规范 §4、§5、§6.1）。
 *
 * 边界语义：manifest 的 `$schema`/`name` 非法时整包拒绝；未知顶层字段只告警；
 * 单个技能不合法只跳过该技能；所有路径按解析后的真实路径做 containment。
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { errorOf, isRecord, type Diagnostic } from "./diagnostics.ts";
import { collectServers } from "./mcp-config.ts";
import { isContained } from "./paths.ts";
import type { DiscoveredPlugin } from "./types.ts";

export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const PLUGIN_NAME = /^(?!.*--)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MANIFEST_FIELDS = new Set([
	"$schema",
	"name",
	"version",
	"displayName",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions",
]);
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);

/** Agent Skills 前置元数据只取 name/description；支持单行、引号与折叠块标量。 */
function readFrontmatter(text: string): Record<string, string> {
	const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return {};
	const fields: Record<string, string> = {};
	const lines = match[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const entry = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!entry) continue;
		const key = entry[1];
		let value = entry[2].trim();
		if (value === ">" || value === "|" || value === ">-" || value === "|-") {
			const folded: string[] = [];
			while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
				index += 1;
				folded.push(lines[index].trim());
			}
			value = value.startsWith(">") ? folded.join(" ") : folded.join("\n");
		} else if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}
	return fields;
}

/** Agent Skills 可选字段的类型约束；违反视为该技能不符合技能规范。 */
function invalidSkillFields(fields: Record<string, string>): string | undefined {
	if (fields.license !== undefined && fields.license.length === 0) return "license 必须是非空字符串";
	if (fields.compatibility !== undefined && (fields.compatibility.length === 0 || fields.compatibility.length > 500)) {
		return "compatibility 必须是 1-500 字符";
	}
	return undefined;
}

async function collectSkills(root: string, diagnostics: Diagnostic[]): Promise<string[]> {
	const skillsDir = join(root, "skills");
	const skillsDirStat = await stat(skillsDir).catch(() => undefined);
	if (!skillsDirStat) return [];
	// §6.2：固定位置存在但不是目录 → 该组件类型无效并继续加载其它类型。
	if (!skillsDirStat.isDirectory()) {
		diagnostics.push(errorOf("skills 不是目录，已禁用该插件的技能", skillsDir));
		return [];
	}
	// §4.1：固定位置逃逸插件根 → 该组件类型无效。
	if (!(await isContained(root, skillsDir))) {
		diagnostics.push(errorOf("skills 解析到插件根之外，已禁用该插件的技能", skillsDir));
		return [];
	}
	let entries: string[];
	try {
		entries = await readdir(skillsDir);
	} catch {
		return [];
	}
	const skills: string[] = [];
	for (const entry of entries.sort()) {
		const directory = join(skillsDir, entry);
		const metadata = await stat(directory).catch(() => undefined);
		if (!metadata?.isDirectory()) continue;
		const skillFile = join(directory, "SKILL.md");
		const fileMetadata = await stat(skillFile).catch(() => undefined);
		if (!fileMetadata?.isFile()) {
			diagnostics.push(errorOf(`技能 ${entry} 缺少 SKILL.md`, skillFile));
			continue;
		}
		if (!(await isContained(root, skillFile))) {
			diagnostics.push(errorOf(`技能 ${entry} 的 SKILL.md 解析到插件根之外`, skillFile));
			continue;
		}
		const frontmatter = readFrontmatter(await readFile(skillFile, "utf8").catch(() => ""));
		const name = frontmatter.name;
		const description = frontmatter.description;
		if (!name || !SKILL_NAME.test(name) || name !== entry) {
			diagnostics.push(errorOf(`技能 ${entry} 的 name 缺失、非法或与目录名不一致`, skillFile));
			continue;
		}
		if (!description || description.length > 1024) {
			diagnostics.push(errorOf(`技能 ${entry} 的 description 缺失或超过 1024 字符`, skillFile));
			continue;
		}
		const invalid = invalidSkillFields(frontmatter);
		if (invalid) {
			diagnostics.push(errorOf(`技能 ${entry}: ${invalid}`, skillFile));
			continue;
		}
		skills.push(skillFile);
	}
	return skills;
}

/** §5.4：元数据只按 JSON 类型校验，且不得因非 SemVer/非 URL/非 SPDX 拒绝。 */
function invalidMetadata(manifest: Record<string, unknown>): string | undefined {
	for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
		const value = manifest[field];
		if (value !== undefined && typeof value !== "string") return `${field} 必须是字符串`;
	}
	if (manifest.keywords !== undefined) {
		const keywords = manifest.keywords;
		if (!Array.isArray(keywords) || keywords.some((value) => typeof value !== "string")) {
			return "keywords 必须是字符串数组";
		}
	}
	if (manifest.author !== undefined) {
		const author = manifest.author;
		if (!isRecord(author)) return "author 必须是对象";
		for (const [key, value] of Object.entries(author)) {
			if (!AUTHOR_FIELDS.has(key)) return `author 含未知字段 ${key}`;
			if (typeof value !== "string") return `author.${key} 必须是字符串`;
		}
	}
	return undefined;
}

async function loadPlugin(root: string, agentDir: string): Promise<DiscoveredPlugin | { diagnostics: Diagnostic[] }> {
	const manifestPath = join(root, "plugin.json");
	const diagnostics: Diagnostic[] = [];
	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {
		return { diagnostics: [errorOf("plugin.json 缺失或无法解析", manifestPath)] };
	}
	if (!isRecord(manifest)) return { diagnostics: [errorOf("plugin.json 顶层必须是对象", manifestPath)] };
	if (manifest.$schema !== PLUGIN_SCHEMA) {
		return {
			diagnostics: [errorOf(`不支持的 Agent Plugins 版本: ${String(manifest.$schema ?? "(缺失)")}`, manifestPath)],
		};
	}
	const name = manifest.name;
	if (typeof name !== "string" || name.length > 64 || !PLUGIN_NAME.test(name)) {
		return { diagnostics: [errorOf(`插件名不合法: ${String(name)}`, manifestPath)] };
	}
	if (!(await isContained(root, manifestPath))) {
		return { diagnostics: [errorOf("plugin.json 解析到插件根之外", manifestPath)] };
	}
	for (const key of Object.keys(manifest)) {
		if (!MANIFEST_FIELDS.has(key)) {
			diagnostics.push({ severity: "warning", message: `忽略未知清单字段 ${key}`, path: manifestPath });
		}
	}
	// §8.1：extensions 非对象属于显式非致命项，报告后忽略。
	if (manifest.extensions !== undefined && !isRecord(manifest.extensions)) {
		diagnostics.push({ severity: "warning", message: "忽略非对象的 extensions 字段", path: manifestPath });
	}
	const metadataProblem = invalidMetadata(manifest);
	if (metadataProblem) return { diagnostics: [...diagnostics, errorOf(metadataProblem, manifestPath)] };
	const description = typeof manifest.description === "string" ? manifest.description : undefined;
	const skills = await collectSkills(root, diagnostics);
	const servers = await collectServers(
		{ name, root, ...(description ? { description } : {}) },
		{ root, data: join(agentDir, "plugin-data", name) },
		diagnostics,
	);
	return { name, root, ...(description ? { description } : {}), skills, servers, diagnostics };
}

/** 扫描插件主目录的直接子目录；只有含 `plugin.json` 的目录才算插件。 */
export async function discoverPlugins(
	pluginsHome: string,
	agentDir: string,
): Promise<{ plugins: DiscoveredPlugin[]; diagnostics: Diagnostic[] }> {
	const diagnostics: Diagnostic[] = [];
	let entries: string[];
	try {
		entries = await readdir(pluginsHome);
	} catch {
		return { plugins: [], diagnostics };
	}
	const plugins: DiscoveredPlugin[] = [];
	for (const entry of entries.sort()) {
		const candidate = join(pluginsHome, entry);
		const metadata = await stat(candidate).catch(() => undefined);
		if (!metadata?.isDirectory()) continue;
		// §9.1：PLUGIN_ROOT 必须是文件系统解析后的绝对路径（插件目录可能是软链）。
		const root = await realpath(candidate).catch(() => candidate);
		if (!(await stat(join(root, "plugin.json")).catch(() => undefined))) continue;
		const loaded = await loadPlugin(root, agentDir);
		if ("diagnostics" in loaded && !("name" in loaded)) {
			diagnostics.push(...loaded.diagnostics);
			continue;
		}
		const plugin = loaded as DiscoveredPlugin;
		diagnostics.push(...plugin.diagnostics);
		plugins.push(plugin);
	}
	return { plugins, diagnostics };
}
