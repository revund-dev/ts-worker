#!/usr/bin/env node
// Thin launcher so `npm install -g @revund/ts-worker` produces a working
// `revund-ts-worker` binary on PATH. The compiled server lives in
// dist/server.js; tsc doesn't preserve shebangs, so we wrap rather than
// shebang the compiled module.
require("../dist/server.js");
