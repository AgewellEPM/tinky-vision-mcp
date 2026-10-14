#!/usr/bin/env node
// One MCP connection for IsolatedTester + TinkyVision + managed TinkyStream.
import { startSystem } from './unified/system.mjs';

startSystem().catch(error => {
  console.error(`[isolated-vision-system] ${error.message}`);
  process.exitCode = 1;
});
