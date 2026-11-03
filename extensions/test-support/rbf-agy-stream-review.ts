import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createAgyStreamProfile } from "./agy-stream-profile.js";

const host=process.env.RBF_AGY_PI ?? join(process.env.HOME!,"Library/pnpm/bin/pi");
if(!existsSync(host))throw new Error("Daily Pi is missing. Set RBF_AGY_PI to its executable; no other host will be selected.");
const wrapper=resolve(import.meta.dirname,"rbf-agy-stream-host-extension.ts");
if(!existsSync(wrapper)||!existsSync(resolve(import.meta.dirname,"agy-stream-worker.cjs")))throw new Error("Offline candidate support is incomplete");
const profile=createAgyStreamProfile();
console.log("Offline AGY streaming candidate. No model requests or native AGY.\nType Summarize the change. Expected final: alpha beta.\nAlso available: short, empty, long, error, cancel (press Esc while running).\nEvidence and isolated saved history: "+profile.root);
const child=spawn(host,["--no-extensions","--no-skills","--no-prompt-templates","-e",wrapper,"--session-dir",profile.sessions,"--tui-mode","fullscreen"],{cwd:profile.root,stdio:"inherit",env:{...process.env,PI_CODING_AGENT_DIR:profile.agent,RBF_AGY_STREAM_ROOT:profile.root,RBF_AGY_STREAM_SCENARIO:"interactive"}});
child.on("error",error=>{console.error("Offline candidate could not start: "+error.message);process.exitCode=1;});
child.on("close",code=>{process.exitCode=code ?? 1;});
