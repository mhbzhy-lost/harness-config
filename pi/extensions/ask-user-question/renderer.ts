import { MouseRegion, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { failedResultLine, resultStatus, setRenderStatus } from "../compact-tools/index.ts";

type Question = { question?: unknown; options?: unknown; multiSelect?: unknown };
type Option = { label?: unknown };
type Answer = { answer?: unknown; selected?: unknown };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function glyph(status: string | undefined, theme: any): string {
  if (status === "failure") return theme.fg("error", "✗");
  if (status === "loading") return theme.fg("warning", "…");
  if (status === "success") return theme.fg("success", "✓");
  return theme.fg("dim", "•");
}

function fitLine(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
}

function hasAnswerData(entry: Answer | null | undefined): boolean {
  if (entry === null || typeof entry !== "object") return false;
  if (Array.isArray(entry.selected)) return true;
  return typeof entry.answer === "string" && text(entry.answer) !== "";
}

function optionLabels(question: Question): string[] | undefined {
  if (!Array.isArray(question.options)) return undefined;
  const labels: string[] = [];
  for (const option of question.options as Option[]) {
    if (!option || typeof option !== "object" || typeof option.label !== "string") return undefined;
    labels.push(option.label);
  }
  return labels;
}

function questionLines(
  name: string,
  question: Question,
  entry: Answer | null | undefined,
  status: string | undefined,
  theme: any,
  width: number,
): string[] {
  const answered = hasAnswerData(entry);
  const head = `${answered ? glyph(status, theme) : glyph("loading", theme)} ${theme.bold(name)} ${text(question.question)}`;
  const labels = optionLabels(question);
  const selected = new Set<string>();
  let custom: string | undefined;
  if (answered && entry) {
    if (question.multiSelect === true) {
      for (const item of Array.isArray(entry.selected) ? entry.selected : []) {
        if (typeof item === "string") selected.add(item);
      }
    } else if (typeof entry.answer === "string") {
      if (labels?.includes(entry.answer)) selected.add(entry.answer);
      else custom = text(entry.answer);
    }
  }
  const lines = [fitLine(head, width)];
  if (labels) {
    for (const label of labels) {
      const isSelected = selected.has(label);
      lines.push(fitLine(`   ${theme.fg(isSelected ? "accent" : "dim", isSelected ? "●" : "○")} ${text(label)}`, width));
    }
    if (custom !== undefined) {
      lines.push(fitLine(`   ${theme.fg("accent", "●")} ${custom}`, width));
    }
  }
  return lines;
}

function resultText(result: any): string {
  const content = typeof result?.content === "string"
    ? [result.content]
    : Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block: any) => typeof block === "string" || block?.type === "text")
    .map((block: any) => (typeof block === "string" ? block : typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function swallowExpandClick(component: Component): MouseRegion {
  return new MouseRegion(component, (event) =>
    event.type === "click" && event.button === "left" ? { handled: true } : undefined,
  );
}

export function createAskUserQuestionRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "ask_user_question") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        const questions = Array.isArray(args?.questions) ? args.questions as Question[] : [];
        context.state.questions = questions;
        const card: Component = {
          render(width: number) {
            const answers = Array.isArray(context.state.answers) ? context.state.answers as (Answer | null)[] : [];
            const lines = questions.flatMap((question, index) =>
              questionLines(name, question, answers[index], context.state.status, theme, width),
            );
            return lines.length ? lines : [fitLine(`${glyph(context.state.status, theme)} ${theme.bold(name)}`, width)];
          },
          invalidate() {},
        };
        return swallowExpandClick(card);
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        const answers = result?.details?.answers ?? result?.structuredContent?.answers;
        if (Array.isArray(answers)) context.state.answers = answers;
        const status = resultStatus(result, options, context);
        setRenderStatus(context, status);
        if (status === "failure") {
          const full = resultText(result);
          if (options?.expanded) {
            return new Text(full, 0, 0);
          }
          return failedResultLine({ truncateToWidth, text: full, theme });
        }
        return new Text("", 0, 0);
      },
    };
  };
}
