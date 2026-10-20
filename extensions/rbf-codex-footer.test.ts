import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createCodexAgentPointer, installCodexAgentsFooter } from "./rbf-codex.ts";
import { patchFooterComponent, unpatchFooterComponent } from "./rbf-background-tasks.ts";

const KEY = Symbol.for("@earendil-works/pi-rbf:footer-registry");
const proto = FooterComponent.prototype as any;
const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => "\x1b[7m" + text + "\x1b[27m" };
let originalRender: any, originalMouse: any;
let cleanup: Array<() => void> = [];
const footer = () => ({ session: {} });
const render = (f: any, width = 80) => proto.render.call(f, width);
const mouse = (f: any, type: string, x: number, button = "left", y = 1) => proto.handleMouse?.call(f, { type, x, y, button, screenX: x, screenY: 39 + y });
function install(visible = () => true, open = vi.fn(), pointer?: (inside: boolean) => void) { const owner = installCodexAgentsFooter(visible, open, () => theme, pointer); cleanup.push(() => owner.dispose()); return { owner, open }; }
function label(f: any, width = 80) { const line = stripTerminalSequences(render(f, width)[1]); return { line, x: line.indexOf("agents") }; }

beforeEach(() => { initTheme(); originalRender = proto.render; originalMouse = proto.handleMouse; delete proto[KEY]; proto.render = (_width: number) => ["/workspace", "10%/1000k (auto)                         model"]; delete proto.handleMouse; });
afterEach(() => { for (const done of cleanup.reverse()) done(); cleanup = []; unpatchFooterComponent(); proto.render = originalRender; if (originalMouse) proto.handleMouse = originalMouse; else delete proto.handleMouse; delete proto[KEY]; });

describe("Codex agents footer", () => {
 it("hover highlights only the label and a left click opens exactly once", () => {
  const f = footer(), { open } = install(); const { x, line } = label(f); expect(line).toContain("· agents"); expect(line).toContain("model");
  expect(mouse(f, "move", x)).toMatchObject({ handled: true, render: true }); expect(render(f)[1]).toContain("\x1b[7m");
  mouse(f, "press", x); expect(open).not.toHaveBeenCalled(); mouse(f, "click", x); expect(open).toHaveBeenCalledTimes(1);
  mouse(f, "click", x, "right"); mouse(f, "click", x - 2); mouse(f, "click", x, "left", 0); expect(open).toHaveBeenCalledTimes(1);
 });
 it("pointer exit clears highlight without consuming unrelated input", () => {
  const f = footer(), { owner } = install(); const { x } = label(f); mouse(f, "move", x); expect(owner.pointerInput("draft")).toBe(false);
  expect(owner.pointerInput("\x1b[<35;1;1M")).toBe(true); expect(render(f)[1]).not.toContain("\x1b[7m");
 });
 it("hidden and clipped labels have no invisible click target; resize restores it", () => {
  let visible = true; const f = footer(), { open } = install(() => visible); const { x } = label(f);
  render(f, 20); mouse(f, "click", x); expect(open).not.toHaveBeenCalled();
  const resized = label(f, 80); mouse(f, "click", resized.x); expect(open).toHaveBeenCalledTimes(1);
  visible = false; expect(label(f).line).not.toContain("agents"); mouse(f, "click", resized.x); expect(open).toHaveBeenCalledTimes(1);
 });
 it("reset discards old hover and hitboxes before the next render", () => {
  const f = footer(), { owner, open } = install(); const { x } = label(f); mouse(f, "move", x); owner.reset(); mouse(f, "click", x); expect(open).not.toHaveBeenCalled(); expect(render(f)[1]).not.toContain("\x1b[7m");
 });
 for (const first of ["agents", "shells"]) it("coexists with shell render/click in " + first + " load order", () => {
  const f = footer(), shellOpen = vi.fn(); let a: ReturnType<typeof install>;
  const shells = () => patchFooterComponent({ getRunningTasks: () => [{}] } as any, () => false, () => false, shellOpen);
  if (first === "agents") { a = install(); shells(); } else { shells(); a = install(); }
  const { x, line } = label(f); expect(line).toContain("1 shell"); mouse(f, "click", x); expect(a.open).toHaveBeenCalledTimes(1); expect(shellOpen).not.toHaveBeenCalled();
  mouse(f, "click", line.indexOf("1 shell") + 2); expect(shellOpen).toHaveBeenCalledTimes(1); expect(a.open).toHaveBeenCalledTimes(1);
  a.owner.dispose(); expect(label(f).line).not.toContain("agents"); expect(label(f).line).toContain("1 shell");
 });
 it("a stale owner cannot unregister its replacement, and final cleanup restores original methods", () => {
  const base = proto.render, f = footer(), a = install(), b = install(); a.owner.dispose(); const { x } = label(f); mouse(f, "click", x); expect(a.open).not.toHaveBeenCalled(); expect(b.open).toHaveBeenCalledTimes(1);
  b.owner.dispose(); expect(proto.render).toBe(base); expect(proto.handleMouse).toBeUndefined(); expect(proto[KEY]).toBeUndefined();
 });
});


describe("Codex agents mouse shape", () => {
 for (const env of [{TERM_PROGRAM:"ghostty"},{TERM_PROGRAM:"cmux"},{TERM:"xterm-ghostty"},{TERM:"xterm-kitty"},{KITTY_WINDOW_ID:"3"}]) it("writes coalesced hand/text for " + JSON.stringify(env), () => {
  const write = vi.fn(), pointer = createCodexAgentPointer(env,true,write); pointer(false);pointer(true);pointer(true);pointer(false);pointer(false);
  expect(write.mock.calls.map(c=>c[0])).toEqual(["\x1b]22;pointer\x1b\\","\x1b]22;text\x1b\\"]);
 });
 for (const [env,tty] of [[{TERM_PROGRAM:"Apple_Terminal"},true],[{TERM_PROGRAM:"ghostty",TMUX:"/tmp/tmux"},true],[{TERM_PROGRAM:"ghostty",STY:"screen"},true],[{TERM_PROGRAM:"ghostty"},false],[{},true]] as const) it("keeps unsupported/non-TTY/multiplexer fallback for " + JSON.stringify([env,tty]), () => {
  const write=vi.fn(),pointer=createCodexAgentPointer(env,tty,write);pointer(true);pointer(false);expect(write).not.toHaveBeenCalled();
 });
 it("clears the hand on exit, click, clip and hidden label", () => {
  let visible=true;const pointer=vi.fn(),f=footer(),a=install(()=>visible,vi.fn(),pointer);let {x}=label(f);
  mouse(f,"move",x);mouse(f,"move",x);expect(pointer.mock.calls).toEqual([[true]]);
  a.owner.pointerInput("\x1b[<35;1;1M");expect(pointer.mock.calls.at(-1)).toEqual([false]);
  label(f);mouse(f,"move",x);mouse(f,"click",x);expect(pointer.mock.calls.at(-1)).toEqual([false]);
  label(f);mouse(f,"move",x);render(f,20);expect(pointer.mock.calls.at(-1)).toEqual([false]);
  label(f);mouse(f,"move",x);visible=false;render(f);expect(pointer.mock.calls.at(-1)).toEqual([false]);
 });
 it("replacement resets its old hand, and stale dispose cannot clear the new hand", () => {
  const f=footer(),old=vi.fn(),fresh=vi.fn(),a=install(()=>true,vi.fn(),old);const {x}=label(f);mouse(f,"move",x);
  const b=install(()=>true,vi.fn(),fresh);expect(old.mock.calls).toEqual([[true],[false]]);label(f);mouse(f,"move",x);a.owner.dispose();expect(fresh.mock.calls).toEqual([[true]]);b.owner.dispose();expect(fresh.mock.calls).toEqual([[true],[false]]);
 });
 it("pointer output failure stays display-local", () => {
  const f=footer(),open=vi.fn();install(()=>true,open,()=>{throw Error("terminal closed");});const {x}=label(f);expect(()=>mouse(f,"move",x)).not.toThrow();mouse(f,"click",x);expect(open).toHaveBeenCalledOnce();
 });
});
