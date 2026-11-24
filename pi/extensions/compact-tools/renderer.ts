import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { COMPACT_STATUS_KEY, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "./status.ts";
import { createExpandedToolText } from "./expanded-content.ts";

const TOOL_NAMES = ["read", "bash", "bash_async", "edit", "write", "find", "grep", "ls", "tool_search"];
const COMPACT_SKILL_PATCH = Symbol.for("harness-config.pi.compact-skill-renderer");
const COMPACT_SUMMARY_KEY = "compactToolsSummary";

function shortPath(path: any) {
  const home = homedir();
  return path === home || path?.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path || ".";
}

function skillName(args: any) {
  const path = args?.path || args?.file_path;
  return basename(path || "") === "SKILL.md" ? basename(dirname(path)) : undefined;
}

function truncate(text: string, max: number) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function textOutput(result: any) {
  return result?.content?.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("\n") || "";
}

function nonEmptyLineCount(text: string) {
  return text ? text.split("\n").filter((line) => line.trim()).length : 0;
}

function title(name: string, detail: string, theme: any) {
  return `${theme.fg("toolTitle", theme.bold(name))}${detail ? ` ${detail}` : ""}`;
}

function expandedBlock(text: string, theme: any, Text: any) {
  return createExpandedToolText(Text, theme.fg("toolOutput", text));
}

function serializedBlock(block: any) {
  if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
    const keys = Object.keys(block);
    if (keys.every((key) => key === "type" || key === "text")) return block.text;
    return `${block.text}\ncontentBlock:\n${serializedValue(block)}`;
  }
  const serialized = JSON.stringify(block, null, 2);
  return serialized === undefined ? String(block) : serialized;
}

function serializedValue(value: unknown) {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

function fullResultText(result: any) {
  const content = typeof result?.content === "string"
    ? [result.content]
    : Array.isArray(result?.content) ? result.content.map(serializedBlock) : [];
  return content.join("\n");
}

function setStatus(context: any, status: CompactRenderStatus) {
  if (!context?.state) return;
  context.state[COMPACT_STATUS_KEY] = status;
  syncStatusAnimation(context, status);
}

export function failedResultLine({ truncateToWidth, text, theme }: { truncateToWidth: any; text: string; theme: any }) {
  const errorText = text.trim().split(/\r?\n/)[0] || "工具执行失败（未提供错误信息）";
  let line = theme.fg("error", errorText);
  return {
    render(width: number) {
      return [truncateToWidth(line, width, "…")];
    },
    invalidate() {
      line = theme.fg("error", errorText);
    },
  };
}

function resultRenderer({ Text, truncateToWidth, summary }: { Text: any; Container: any; truncateToWidth: any; summary: (text: string) => string }) {
  return (result: any, options: any, theme: any, context: any) => {
    const text = textOutput(result);
    const failed = context?.isError === true || result?.isError === true;
    const partial = options?.isPartial === true;
    const resultSummary = failed ? "失败" : summary(text);
    if (context?.state) {
      setStatus(context, failed ? "failure" : partial ? "loading" : "success");
      if (failed || partial || options.expanded) delete context.state[COMPACT_SUMMARY_KEY];
    }
    if (options.expanded) {
      const expanded = fullResultText(result);
      if (expanded) return expandedBlock(expanded, theme, Text);
      return new Text(theme.fg("dim", `  └ ${resultSummary}`), 1, 0);
    }
    if (failed) return failedResultLine({ truncateToWidth, text, theme });
    if (partial) return new Text("", 0, 0);
    if (context?.state) context.state[COMPACT_SUMMARY_KEY] = resultSummary;
    return new Text("", 0, 0);
  };
}

export function installCompactSkillRenderer({ SkillInvocationMessageComponent, Text, Markdown, theme }: any) {
  const prototype = SkillInvocationMessageComponent?.prototype;
  if (!prototype || prototype[COMPACT_SKILL_PATCH]) return;

  Object.defineProperty(prototype, COMPACT_SKILL_PATCH, { value: true });
  prototype.updateDisplay = function updateCompactSkillDisplay(this: any) {
    this.clear();
    this.paddingX = 0;
    this.paddingY = 0;
    this.setBgFn(undefined);

    this.addChild(new Text(title("skill", theme.fg("accent", this.skillBlock.name), theme), 0, 0));
    if (!this.expanded) return;

    const markdown = new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
      color: (text: string) => theme.fg("toolOutput", text),
    });
    this.addChild({
      render(width: number) {
        const lines = markdown.render(Math.max(1, width - 2));
        return [
          ...lines.map((line: string) => `${theme.fg("dim", "│")} ${line}`),
          theme.fg("dim", "└─"),
        ];
      },
      invalidate() {
        markdown.invalidate?.();
      },
    });
  };
}

function summarySuffix(theme: any, context: any) {
  const summary = !context?.expanded ? context?.state?.[COMPACT_SUMMARY_KEY] : undefined;
  return summary ? theme.fg("dim", ` · ${summary}`) : "";
}

function createSingleLine({ visibleWidth, truncateToWidth }: { visibleWidth: any; truncateToWidth: any }) {
  return (text: string, theme: any, context: any) => ({
    render(width: number) {
      const status = context?.state?.[COMPACT_STATUS_KEY] as CompactRenderStatus | undefined;
      syncStatusAnimation(context, status);
      const glyph = statusGlyph(theme, status);
      const summary = summarySuffix(theme, context);
      const textBudget = Math.max(0, width - visibleWidth(glyph) - 1 - visibleWidth(summary));
      return [`${glyph} ${truncateToWidth(text, textBudget, "…")}${summary}`];
    },
    invalidate() {},
  });
}

function firstStringArg(args: any) {
  const value = Object.values(args ?? {}).find((entry) => typeof entry === "string");
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function createCompactFallbackRenderers({ Text, Container, visibleWidth, truncateToWidth }: any) {
  const singleLine = createSingleLine({ visibleWidth, truncateToWidth });
  const renderResult = resultRenderer({
    Text,
    Container,
    truncateToWidth,
    summary: (text) => `${nonEmptyLineCount(text)} lines`,
  });
  return (name: string) => ({
    renderCall(args: any, theme: any, context: any) {
      const arg = firstStringArg(args);
      return singleLine(title(name, arg ? theme.fg("accent", `"${arg}"`) : "", theme), theme, context);
    },
    renderResult,
  });
}

export function createCompactToolRenderers({
  Text,
  Container,
  visibleWidth,
  sliceByColumn,
  truncateToWidth,
  nativeEditRenderers = undefined as { current?: import("@earendil-works/pi-coding-agent").ToolRenderers } | undefined,
}: any) {
  const singleLine = createSingleLine({ visibleWidth, truncateToWidth });

  const expandedLine = (text: string, _theme: any, context: any) => ({
    render(width: number) {
      const status = context?.state?.[COMPACT_STATUS_KEY] as CompactRenderStatus | undefined;
      syncStatusAnimation(context, status);
      const glyph = statusGlyph(_theme, status);
      return new Text(`${glyph} ${text}`, 0, 0).render(width);
    },
    invalidate() {},
  });

  const pathCall = (name: string, path: string, suffix: string, theme: any, context: any) => ({
    render(width: number) {
      const prefix = `${title(name, "", theme)} `;
      const status = context?.state?.[COMPACT_STATUS_KEY] as CompactRenderStatus | undefined;
      syncStatusAnimation(context, status);
      const glyph = statusGlyph(theme, status);
      const summary = summarySuffix(theme, context);
      const fixedWidth = visibleWidth(glyph) + 1 + visibleWidth(prefix) + visibleWidth(suffix) + visibleWidth(summary);
      const pathBudget = Math.max(0, width - fixedWidth);
      const pathWidth = visibleWidth(path);
      let displayedPath = path;
      if (pathWidth > pathBudget) {
        displayedPath = pathBudget <= 1
          ? "…".slice(0, pathBudget)
          : `…${sliceByColumn(path, pathWidth - pathBudget + 1, pathBudget - 1, true)}`;
      }
      const call = `${prefix}${theme.fg("accent", displayedPath)}${suffix}`;
      const callBudget = Math.max(0, width - visibleWidth(summary));
      return [`${glyph} ${truncateToWidth(call, Math.max(0, callBudget - visibleWidth(glyph) - 1), "…")}${summary}`];
    },
    invalidate() {},
  });

  const editCompactResultRenderer = resultRenderer({ Text, Container, truncateToWidth, summary: () => "done" });
  const editRenderResult = (result: any, options: any, theme: any, context: any) => {
    const failed = context?.isError === true || result?.isError === true;
    const partial = options?.isPartial === true;
    const native = nativeEditRenderers?.current;
    setStatus(context, failed ? "failure" : partial ? "loading" : "success");
    if (
      options?.expanded === true
      && !failed
      && !partial
      && typeof native?.renderResult === "function"
    ) {
      const nativeComponent = native.renderResult(result, options, theme, { ...context, lastComponent: undefined });
      const raw = fullResultText(result);
      if (!raw) return nativeComponent;
      const container = new Container();
      if (nativeComponent) container.addChild(nativeComponent);
      container.addChild(expandedBlock(raw, theme, Text));
      return container;
    }
    return editCompactResultRenderer(result, options, theme, context);
  };

  const renderers: Record<string, any> = {
    read: {
      renderCall(args: any, theme: any, context: any) {
        const loadedSkill = !context?.expanded && skillName(args);
        if (loadedSkill) return singleLine(title("skill", theme.fg("accent", loadedSkill), theme), theme, context);

        const start = args?.offset;
        const end = args?.limit ? (start || 1) + args.limit - 1 : undefined;
        const range = start || end ? theme.fg("warning", `:${start || 1}${end ? `-${end}` : ""}`) : "";
        return pathCall("read", shortPath(args?.path || args?.file_path), range, theme, context);
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        if (!options.expanded && skillName(context?.args) && context?.isError !== true && result?.isError !== true) {
          if (context?.state) {
            setStatus(context, options.isPartial === true ? "loading" : "success");
            delete context.state[COMPACT_SUMMARY_KEY];
          }
          return new Text("", 0, 0);
        }
        return resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} lines` })(
          result,
          options,
          theme,
          context,
        );
      },
    },
    bash: {
      renderCall(args: any, theme: any, context: any) {
        const rawCommand = String(args?.command || "...");
        if (context?.expanded) {
          return expandedLine(title("bash", theme.fg("accent", `"${rawCommand}"`), theme), theme, context);
        }
        const command = rawCommand.replace(/\s+/g, " ").trim();
        return singleLine(title("bash", theme.fg("accent", `"${command}"`), theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} lines` }),
    },
    bash_async: {
      renderCall(args: any, theme: any, context: any) {
        const rawCommand = String(args?.command || "...");
        if (context?.expanded) {
          return expandedLine(title("bash_async", theme.fg("accent", `"${rawCommand}"`), theme), theme, context);
        }
        const command = rawCommand.replace(/\s+/g, " ").trim();
        return singleLine(title("bash_async", theme.fg("accent", `"${command}"`), theme), theme, context);
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        const text = textOutput(result);
        const failed = context?.isError === true || result?.isError === true;
        const partial = options.isPartial === true;
        const launch = !failed && !partial && result?.details?.kind === "bash-async-launch"
          ? result.details
          : undefined;
        const shortJob = launch && typeof launch.jobId === "string" && launch.jobId
          ? ` (${launch.jobId.slice(0, 8)})`
          : "";
        const launchSummary = launch ? `已接受，待完成${shortJob}` : undefined;
        if (options.expanded) {
          setStatus(context, failed || (!launch && !partial) ? "failure" : launch ? "success" : "loading");
          const expanded = fullResultText(result);
          if (expanded) return expandedBlock(expanded, theme, Text);
          return new Text(theme.fg("dim", `  └ ${failed ? "失败" : launchSummary || "（未识别的回执格式）"}`), 1, 0);
        }
        if (launch) {
          if (context?.state) {
            setStatus(context, "success");
            context.state[COMPACT_SUMMARY_KEY] = launchSummary;
          }
          return new Text("", 0, 0);
        }
        setStatus(context, failed || !partial ? "failure" : "loading");
        if (context?.state) delete context.state[COMPACT_SUMMARY_KEY];
        if (failed) return failedResultLine({ truncateToWidth, text, theme });
        const unknownText = text ? truncate(text.replace(/\s+/g, " ").trim(), 100) : "（未识别的回执格式）";
        if (partial) return new Text(theme.fg("dim", unknownText), 1, 0);
        if (context?.state) context.state[COMPACT_SUMMARY_KEY] = unknownText;
        return new Text("", 0, 0);
      },
    },
    edit: {
      renderCall(args: any, theme: any, context: any) {
        const count = Array.isArray(args?.edits) ? args.edits.length : 1;
        return pathCall(
          "edit",
          shortPath(args?.path || args?.file_path),
          ` ${theme.fg("dim", `(${count} edit${count === 1 ? "" : "s"})`)}`,
          theme,
          context,
        );
      },
      renderResult: editRenderResult,
    },
    write: {
      renderCall(args: any, theme: any, context: any) {
        return pathCall("write", shortPath(args?.path || args?.file_path), "", theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: () => "done" }),
    },
    find: {
      renderCall(args: any, theme: any, context: any) {
        const pattern = args?.pattern || args?.glob || "*";
        const detail = `${theme.fg("accent", `"${pattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        return singleLine(title("find", detail, theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} matches` }),
    },
    grep: {
      renderCall(args: any, theme: any, context: any) {
        const rawPattern = String(args?.pattern || "");
        const detail = `${theme.fg("accent", `"${rawPattern}"`)} ${theme.fg("dim", `in ${shortPath(args?.path || args?.dir)}`)}`;
        if (context?.expanded) return expandedLine(title("grep", detail, theme), theme, context);
        return singleLine(title("grep", detail, theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} matches` }),
    },
    ls: {
      renderCall(args: any, theme: any, context: any) {
        return pathCall("ls", shortPath(args?.path), "", theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: (text) => `${nonEmptyLineCount(text)} entries` }),
    },
    tool_search: {
      renderCall(args: any, theme: any, context: any) {
        const query = String(args?.query || "");
        return singleLine(title("tool_search", theme.fg("accent", query), theme), theme, context);
      },
      renderResult: resultRenderer({ Text, Container, truncateToWidth, summary: () => "done" }),
    },
  };

  for (const name of TOOL_NAMES) {
    if (!renderers[name]) throw new Error(`Missing renderer for ${name}`);
    renderers[name].renderShell = "self";
  }
  return renderers;
}
