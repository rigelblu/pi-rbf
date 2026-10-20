// Deterministic local stdio MCP fixture. It serves no files, credentials, network or real service.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
	const request=JSON.parse(line);if(request.id===undefined)continue;
	let result:unknown;
	if(request.method==="initialize")result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"pi52-local",version:"1"}};
	else if(request.method==="tools/list")result={tools:[{name:"echo",description:"Return the test marker",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]};
	else if(request.method==="tools/call") {
		if(process.env.RBF_PI52_MCP_LOG)appendFileSync(process.env.RBF_PI52_MCP_LOG,`${JSON.stringify(request)}\n`);
		result={content:[{type:"text",text:`LOCAL-MCP:${request.params.arguments.text}`}],isError:request.params.arguments.text==="fail"};
	} else result={};
	process.stdout.write(`${JSON.stringify({jsonrpc:"2.0",id:request.id,result})}\n`);
}
