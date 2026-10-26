/*
 * Limebot
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Bot process supervision, deliberately free of Electron imports so it can be
 * exercised with plain Node. The desktop window (main.js) is a thin shell over
 * this: it spawns `node run.js` inside the bot folder, streams its output and
 * makes sure the whole process tree goes away when the volunteer stops it.
 *
 * `run.js` is the bot's own single-file launcher: it installs dependencies on
 * first boot, bundles dist/ with esbuild and then starts the gateway. That is
 * why boot can take minutes the first time — the UI reports it as "starting"
 * until the bot prints its ready line.
 */

"use strict";

const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ANSI_ESCAPE = new RegExp("\\u001B\\[[0-9;]*[A-Za-z]", "g");

// Printed by the bot itself once the gateway handshake is done (see
// bot/src/Client.ts and bot/src/index.ts).
const READY_PATTERN = /Connected as .+\(\d+\)|Connected to Discord gateway/;

// How long a stop request may take before the tree is killed outright.
const STOP_GRACE_MS = 10000;

function stripAnsi(line) {
    return line.replace(ANSI_ESCAPE, "");
}

function npmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Check the Node.js runtime the bot needs. The app does not bundle Node: the
 * bot's native modules (better-sqlite3, sharp) are built for the host's Node
 * ABI by npm during first boot, so an Electron-provided runtime would not do.
 *
 * @returns {{ ok: boolean, nodeVersion: string | null, npmVersion: string | null, error: string | null }}
 */
function checkNode(nodePath = "node") {
    const node = spawnSync(nodePath, ["--version"], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true
    });

    if (node.error || node.status !== 0) {
        const detail = (node.stderr || "").trim() || (node.error ? node.error.message : "exit " + node.status);
        return {
            ok: false,
            nodeVersion: null,
            npmVersion: null,
            error:
                node.error && node.error.code === "ENOENT"
                    ? "Node.js was not found. Install it once, then reopen Limebot."
                    : "Could not run `" + nodePath + " --version`: " + detail
        };
    }

    const nodeVersion = (node.stdout || "").trim();

    // npm ships with Node; `run.js` shells out to it for dependency installs.
    // .cmd shims on Windows can only be resolved through a shell.
    const npm = spawnSync(npmCommand(), ["--version"], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        shell: process.platform === "win32"
    });
    const npmVersion = npm.error || npm.status !== 0 ? null : (npm.stdout || "").trim();

    if (!npmVersion) {
        return {
            ok: false,
            nodeVersion,
            npmVersion: null,
            error: `Node.js ${nodeVersion} is installed but \`npm\` is not usable from it. Reinstall Node.js.`
        };
    }

    const major = Number.parseInt(nodeVersion.replace(/^v/, ""), 10);
    if (Number.isFinite(major) && major < 20) {
        return {
            ok: false,
            nodeVersion,
            npmVersion,
            error: `Node.js ${nodeVersion} is too old — the bot needs Node.js 20 or newer.`
        };
    }

    return { ok: true, nodeVersion, npmVersion, error: null };
}

class BotSupervisor extends EventEmitter {
    /**
     * @param {{ botDir: string, logFile: string, nodePath?: string, bufferSize?: number, stopGraceMs?: number }} options
     */
    constructor({ botDir, logFile, nodePath = "node", bufferSize = 500, stopGraceMs = STOP_GRACE_MS }) {
        super();

        this.botDir = botDir;
        this.logFile = logFile;
        this.nodePath = nodePath;
        this.bufferSize = bufferSize;
        this.stopGraceMs = stopGraceMs;

        this.state = "stopped";
        this.child = null;
        this.startedAt = null;
        this.exitInfo = null;

        this.pendingStop = false;
        /** @type {string | null} Token to start with once a restart finishes stopping. */
        this.pendingRestart = null;
        this.stopTimer = null;

        this.buffers = { stdout: "", stderr: "" };
        /** @type {Array<{ at: number, stream: string, line: string }>} */
        this.recent = [];
        this.logStream = null;
    }

    get running() {
        return this.child !== null;
    }

    snapshot() {
        return {
            state: this.state,
            botDir: this.botDir,
            startedAt: this.startedAt,
            exitInfo: this.exitInfo
        };
    }

    recentLines() {
        return this.recent;
    }

    // --- state plumbing -----------------------------------------------------

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit("state", this.snapshot());
    }

    pushLine(stream, line) {
        const entry = { at: Date.now(), stream, line };
        this.recent.push(entry);
        if (this.recent.length > this.bufferSize) this.recent.shift();

        this.appendToLogFile(entry);
        this.emit("log", entry);
    }

    appendToLogFile({ at, stream, line }) {
        try {
            if (!this.logStream) {
                fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
                this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
                this.logStream.on("error", () => { this.logStream = null; });
            }
            this.logStream.write(`${new Date(at).toISOString()} [${stream}] ${line}\n`);
        } catch {
            // Logging must never take the supervisor down.
        }
    }

    consume(stream, chunk) {
        const text = this.buffers[stream] + chunk.toString();
        const lines = text.split(/\r?\n/);
        this.buffers[stream] = lines.pop() ?? "";

        for (const raw of lines) {
            const line = stripAnsi(raw);
            if (!line.trim()) continue;
            this.pushLine(stream, line);
            if (this.state === "starting" && READY_PATTERN.test(line)) this.setState("running");
        }
    }

    flushBuffers() {
        for (const stream of ["stdout", "stderr"]) {
            const rest = this.buffers[stream];
            this.buffers[stream] = "";
            const line = stripAnsi(rest).trim();
            if (line) this.pushLine(stream, line);
        }
    }

    // --- process control ----------------------------------------------------

    start(token) {
        if (this.child) return { ok: false, error: "The bot is already running." };

        const trimmed = String(token ?? "").trim();
        if (!trimmed) return { ok: false, error: "Paste the bot token first." };

        if (!fs.existsSync(path.join(this.botDir, "run.js"))) {
            return { ok: false, error: `No run.js found in ${this.botDir}.` };
        }

        const node = checkNode(this.nodePath);
        if (!node.ok) return { ok: false, error: node.error };

        let child;
        try {
            child = spawn(this.nodePath, ["run.js"], {
                cwd: this.botDir,
                env: { ...process.env, LIMEBOT_TOKEN: trimmed },
                stdio: ["ignore", "pipe", "pipe"],
                // Own process group on POSIX so `npm install` children can be
                // signalled together with the bot itself.
                detached: process.platform !== "win32",
                windowsHide: true
            });
        } catch (error) {
            return { ok: false, error: `Could not start Node.js: ${error.message}` };
        }

        this.child = child;
        this.exitInfo = null;
        this.pendingStop = false;
        this.pendingRestart = null;
        this.startedAt = Date.now();
        this.buffers = { stdout: "", stderr: "" };

        child.stdout?.on("data", chunk => this.consume("stdout", chunk));
        child.stderr?.on("data", chunk => this.consume("stderr", chunk));

        child.on("error", error => {
            this.pushLine("stderr", `[limebot-app] could not start the bot: ${error.message}`);
        });

        child.on("exit", (code, signal) => {
            if (this.stopTimer) {
                clearTimeout(this.stopTimer);
                this.stopTimer = null;
            }
            this.flushBuffers();
            this.child = null;

            const wasIntentional = this.pendingStop;
            const restartToken = this.pendingRestart;
            this.pendingStop = false;
            this.pendingRestart = null;
            this.exitInfo = { code, signal, at: Date.now() };

            if (restartToken !== null) {
                this.pushLine("app", "[limebot-app] bot stopped — starting it again.");
                this.setState("stopped");
                const result = this.start(restartToken);
                if (!result.ok) {
                    this.pushLine("stderr", "[limebot-app] restart failed: " + result.error);
                    this.setState("stopped");
                }
                return;
            }

            if (wasIntentional) {
                this.pushLine("app", "[limebot-app] bot stopped.");
            } else {
                const how = signal ? `signal ${signal}` : `exit code ${code}`;
                this.pushLine("stderr", `[limebot-app] the bot stopped unexpectedly (${how}).`);
            }

            this.setState(wasIntentional ? "stopped" : "crashed");
        });

        this.pushLine("app", `[limebot-app] starting the bot from ${this.botDir}`);
        this.setState("starting");

        return { ok: true };
    }

    stop() {
        this.pendingRestart = null;

        if (!this.child) {
            this.setState("stopped");
            return { ok: true };
        }

        this.pendingStop = true;
        this.setState("stopping");
        this.pushLine("app", "[limebot-app] stopping the bot…");
        this.signalTree("SIGTERM");

        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = setTimeout(() => {
            if (!this.child) return;
            this.pushLine("stderr", "[limebot-app] the bot ignored the stop request — killing it.");
            this.signalTree("SIGKILL");
        }, this.stopGraceMs);
        this.stopTimer.unref?.();

        return { ok: true };
    }

    restart(token) {
        if (!this.child) return this.start(token);

        const trimmed = String(token ?? "").trim();
        if (!trimmed) return { ok: false, error: "Paste the bot token first." };

        // The exit handler starts the bot again; that keeps exactly one child
        // process alive through the restart instead of racing two of them.
        this.pendingStop = true;
        this.pendingRestart = trimmed;
        this.setState("stopping");
        this.pushLine("app", "[limebot-app] restarting the bot…");
        this.signalTree("SIGTERM");

        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = setTimeout(() => {
            if (this.child) this.signalTree("SIGKILL");
        }, this.stopGraceMs);
        this.stopTimer.unref?.();

        return { ok: true };
    }

    signalTree(signal) {
        const child = this.child;
        if (!child?.pid) return;

        if (process.platform === "win32") {
            // `npm install` spawns helpers of its own; /T takes the whole tree.
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true
            });
            return;
        }

        try {
            process.kill(-child.pid, signal);
        } catch {
            try {
                child.kill(signal);
            } catch {
                // Already gone.
            }
        }
    }

    /** Last-resort synchronous cleanup when the window goes away. */
    dispose() {
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = null;

        if (this.child) {
            this.pendingStop = true;
            this.signalTree("SIGKILL");
        }
        this.logStream?.end();
        this.logStream = null;
    }
}

module.exports = { BotSupervisor, checkNode, READY_PATTERN };
