/**
 * 插件包路径与占位符处理（规范 §4.1、§9）。
 *
 * 两个规则都在这里收口：
 * - containment：包内路径按**解析后的真实路径**判断，symlink 只能指向根内；
 * - 占位符：只展开 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}`，单次、非递归，替换产物不再扫描。
 */

import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const PLACEHOLDER = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g;

export interface PluginVariables {
	root: string;
	data: string;
}

/** 解析到最接近的真实路径，用于 symlink 逃逸检查（目标可能尚不存在）。 */
export async function resolveExisting(target: string): Promise<string> {
	const tail: string[] = [];
	let current = resolve(target);
	for (;;) {
		try {
			const real = await realpath(current);
			return tail.length === 0 ? real : resolve(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(target);
			tail.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			current = parent;
		}
	}
}

/** 目标是否落在 root（或 root 之下），按真实路径比较。 */
export async function isContained(root: string, target: string): Promise<boolean> {
	const resolvedRoot = await resolveExisting(root);
	const resolvedTarget = await resolveExisting(target);
	if (resolvedTarget === resolvedRoot) return true;
	return resolvedTarget.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`);
}

/** §9.2：单次、非递归替换；未识别的占位符文本保持原样。 */
export function expandPlaceholders(value: string, variables: PluginVariables): string {
	return value.replace(PLACEHOLDER, (_match, name) =>
		name === "PLUGIN_ROOT" ? variables.root : variables.data,
	);
}
