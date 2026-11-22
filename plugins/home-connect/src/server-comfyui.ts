/**
 * comfyui MCP server（stdio）入口：WSL ComfyUI 生图。
 * 与 home server 同插件、独立进程；连接层共享 connection.ts，图补丁见 graph.ts。
 */

import { startServer } from "./mcp.ts";
import { COMFYUI_INSTRUCTIONS, COMFYUI_TOOLS, callComfyuiTool } from "./tools-comfyui.ts";

startServer({
	name: "comfyui",
	tools: COMFYUI_TOOLS,
	instructions: COMFYUI_INSTRUCTIONS,
	callTool: callComfyuiTool,
});
