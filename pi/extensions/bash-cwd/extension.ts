export function createBashCwdToolDefinition({
  workspaceRoot = process.cwd(),
  createBashToolDefinition,
  getBashOptions = () => ({}),
}: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any } = {}) {
  if (typeof createBashToolDefinition !== "function") {
    throw new Error("bash settings extension requires createBashToolDefinition");
  }

  const baseDefinition = createBashToolDefinition(workspaceRoot, {});
  return {
    ...baseDefinition,
    name: "bash",
    async execute(id: any, input: any, signal: any, onUpdate: any, ctx: any) {
      const { definition } = await prepareBashCwdExecution({
        workspaceRoot, createBashToolDefinition, getBashOptions,
      }, ctx);
      return definition.execute(id, input, signal, onUpdate, ctx);
    },
  };
}

/** 只解析一次 shell options，供同步与异步 Bash 执行共用。 */
export async function prepareBashCwdExecution(
  { workspaceRoot = process.cwd(), createBashToolDefinition, getBashOptions = () => ({}) }: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any },
  ctx: any,
  transformOptions: (options: any) => any = (options) => options,
) {
  const effectiveCwd = ctx?.cwd ?? workspaceRoot;
  const options = transformOptions(getBashOptions(ctx));
  return { definition: createBashToolDefinition!(effectiveCwd, options), cwd: effectiveCwd };
}

export function createBashCwdExtension(pi: any, options = {}) {
  pi.registerTool(createBashCwdToolDefinition(options));
}

export default createBashCwdExtension;
