/**
 * 时间线可折叠块的展开状态与「全部折叠」逻辑（与 React / 具体 DOM 实现解耦，便于单测）。
 *
 * 可折叠块统一渲染为原生 `<details class="ev ... ev-expandable">`，覆盖：
 * - thinking 思考块
 * - tool 工具卡（running / done / error / interrupted，仅含参数或输出正文的卡片）
 * - event 通用事件（steer / status / compact / retry_failed / session 等，仅多行或超长 detail）
 * assistant 消息、摘要、工作区变更、已验证命令、错误卡片均为静态展示，不属于可折叠块。
 */

export const EXPANDABLE_SELECTOR = "details.ev-expandable";
export const OPEN_EXPANDABLE_SELECTOR = "details.ev-expandable[open]";

/** 可折叠块的 DOM 最小抽象：原生 <details> 的 open 属性 */
export interface ExpandableElement {
  open: boolean;
}

/** 容器最小抽象：只需支持 querySelectorAll，真实 DOM 节点与测试桩均可 */
export interface ExpandableRoot {
  querySelectorAll(selector: string): ArrayLike<ExpandableElement>;
}

export type ExpandedKeySet = ReadonlySet<string>;

/** 用户点击展开/折叠单个块：返回新的不可变集合 */
export function setExpandedKey(expanded: ExpandedKeySet, key: string, open: boolean): ExpandedKeySet {
  const already = expanded.has(key);
  if (open === already) return expanded;
  const next = new Set(expanded);
  if (open) next.add(key);
  else next.delete(key);
  return next;
}

/** 「全部折叠」：清空内部展开状态集合 */
export function clearExpandedKeys(): ExpandedKeySet {
  return new Set();
}

/** 时间线增量重算后，剔除已不在视图中的 key，避免按钮启用态被残留 key 误点亮 */
export function pruneExpandedKeys(
  expanded: ExpandedKeySet,
  items: ReadonlyArray<{ key: string }>,
): ExpandedKeySet {
  if (expanded.size === 0) return expanded;
  const live = new Set(items.map((item) => item.key));
  let stale = false;
  for (const key of expanded) {
    if (!live.has(key)) {
      stale = true;
      break;
    }
  }
  if (!stale) return expanded;
  return new Set([...expanded].filter((key) => live.has(key)));
}

/** 当前视图内是否存在已展开块（决定「全部折叠」按钮启用态） */
export function hasExpandedItem(expanded: ExpandedKeySet, items: ReadonlyArray<{ key: string }>): boolean {
  if (expanded.size === 0) return false;
  for (const item of items) {
    if (expanded.has(item.key)) return true;
  }
  return false;
}

/** 同步关闭容器内所有已展开的 <details>，返回关闭数量；容器缺失时返回 0 */
export function collapseExpandables(root: ExpandableRoot | null | undefined): number {
  if (!root) return 0;
  const nodes = root.querySelectorAll(OPEN_EXPANDABLE_SELECTOR);
  let count = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.open) {
      node.open = false;
      count += 1;
    }
  }
  return count;
}

export interface CollapseAllResult {
  expanded: ExpandedKeySet;
  closedCount: number;
}

/**
 * 「全部折叠」完整动作：
 * 1. 清空内部展开状态（后续流式增量渲染不会把已折叠块重新弹开）；
 * 2. 同步关闭 DOM 中所有已展开 <details>（覆盖 toggle 事件尚未派发、状态未入集合的竞态块）。
 */
export function collapseAll(
  expanded: ExpandedKeySet,
  root: ExpandableRoot | null | undefined,
): CollapseAllResult {
  return { expanded: clearExpandedKeys(), closedCount: collapseExpandables(root) };
}
