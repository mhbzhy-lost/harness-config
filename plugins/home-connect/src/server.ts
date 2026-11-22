/**
 * home-connect MCP server（stdio）入口：家中设备连接工具。
 * 连接层见 connection.ts，工具定义与分发见 tools-home.ts，stdio 协议见 mcp.ts。
 */

import { startServer } from "./mcp.ts";
import { HOME_INSTRUCTIONS, HOME_TOOLS, callHomeTool } from "./tools-home.ts";

startServer({
	name: "home-connect",
	tools: HOME_TOOLS,
	instructions: HOME_INSTRUCTIONS,
	callTool: callHomeTool,
});
