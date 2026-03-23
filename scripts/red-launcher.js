"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

function hasNodeRedTree(root) {
    return fs.existsSync(path.join(root, "packages", "node_modules", "node-red", "red.js"));
}

function resolveAppRoot() {
    const candidates = [];

    if (typeof Bun !== "undefined" && Array.isArray(Bun.argv) && Bun.argv[0]) {
        candidates.push(path.dirname(path.resolve(Bun.argv[0])));
    }
    if (process.argv0) {
        candidates.push(path.dirname(path.resolve(process.argv0)));
    }
    if (process.argv && process.argv[0]) {
        candidates.push(path.dirname(path.resolve(process.argv[0])));
    }
    candidates.push(process.cwd());
    candidates.push(path.dirname(path.resolve(process.execPath)));

    for (const candidate of candidates) {
        if (hasNodeRedTree(candidate)) {
            return candidate;
        }
    }
    return process.cwd();
}

const appRoot = resolveAppRoot();
process.chdir(appRoot);

const redScript = path.join(appRoot, "packages", "node_modules", "node-red", "red.js");
if (!fs.existsSync(redScript)) {
    console.error("Node-RED script not found at:", redScript);
    process.exit(1);
}

const bunBin = process.platform === "win32" ? "bun.exe" : "bun";
const forwardedArgs = process.argv.slice(2);
const child = spawn(bunBin, [redScript].concat(forwardedArgs), {
    cwd: appRoot,
    stdio: "inherit"
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code || 0);
});

child.on("error", (err) => {
    console.error("Failed to start bun runtime:", err && err.message ? err.message : err);
    process.exit(1);
});
