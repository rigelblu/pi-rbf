// Test-only: observe original presentation identities and every rendered grouping frame in the actual host.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
	const log = process.env.RBF_PI52_BINDING_LOG;
	if (!log) return;
	const write = (record: unknown) => appendFileSync(log, `${JSON.stringify(record)}\n`);
	const bindings = new WeakMap<object, any>();
	const announcements=new Map<string,any>();
	pi.events.on("rbf:shell-display:v1", (message: any) => {
		if(message.kind==="announce")announcements.set(message.source,message);
		if (message.kind !== "membership") return;
		const args = message.binding?.deref();
		if (args) { bindings.set(args, message); write({kind:"published",toolCallId:message.toolCallId,source:message.source,threadId:message.threadId,clientGeneration:message.clientGeneration}); }
	});
	pi.on("tool_call", (event) => {
		if (event.toolName === "codex_command" || event.toolName === "codex_tool") write({kind:"validated-input",toolCallId:event.toolCallId,bound:bindings.has(event.input)});
	});
	let active = true;
	const original = (InteractiveMode.prototype as any).handleEvent;
	const owned = new Map<any,{original:any;wrapper:any}>();
	const inspect = (host: any, phase: string) => {
		const rows = host.chatContainer.children.filter((row: any) => row instanceof ToolExecutionComponent && ["codex_command","codex_tool"].includes((row as any).toolName));
		const state = (globalThis as any)[Symbol.for("rbf.shellCommandGroups.view")]?.state;
		write({kind:phase,rows:rows.map((row:any)=>{
			const binding=bindings.get(row.args);
			const member=[...(state?.members.values()??[])].find((member:any)=>member.nativeRow===row) as any;
			return {toolCallId:row.toolCallId,bound:!!binding,executionStarted:row.executionStarted,projected:!!member,source:member?.source,threadId:member?.threadId,clientGeneration:member?.clientGeneration,definitionMatches:row.toolDefinition?.execute===host.session?.getToolDefinition(row.toolName)?.execute,announcedMatches:[...announcements.values()].some((a)=>a.execute===row.toolDefinition?.execute&&a.renderCall===row.toolDefinition?.renderCall&&a.renderResult===row.toolDefinition?.renderResult),expectedThreadId:binding?.threadId,expectedClientGeneration:binding?.clientGeneration};
		}),groups:state?.groups.map((group:any)=>group.memberIds)});
	};
	const wrapped = function(this:any,event:any) {
		const result = original.call(this,event);
		if (!active || !this.chatContainer) return result;
		inspect(this,`event:${event.type}`);
		// Force a projection before pipeline start; normal TUI scheduling can coalesce these stream events.
		if(event.type==="message_update" && this.chatContainer.children.some((row:any)=>row instanceof ToolExecutionComponent && bindings.has((row as any).args) && !(row as any).executionStarted)) this.chatContainer.render(120);
		const chat=this.chatContainer;
		if (!owned.has(chat)) {
			const previous=chat.render;const host=this;
			const wrapper=function(this:any,width:number) {const lines=previous.call(this,width);if(active)inspect(host,"frame");return lines;};
			owned.set(chat,{original:previous,wrapper});chat.render=wrapper;
		}
		return result;
	};
	(InteractiveMode.prototype as any).handleEvent=wrapped;
	pi.on("session_shutdown",()=>{
		active=false;if((InteractiveMode.prototype as any).handleEvent===wrapped)(InteractiveMode.prototype as any).handleEvent=original;
		for(const [chat,record] of owned)if(chat.render===record.wrapper)chat.render=record.original;
		owned.clear();
	});
}
