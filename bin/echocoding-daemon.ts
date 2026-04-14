#!/usr/bin/env node

/**
 * EchoCoding Daemon — runs as a background process.
 * Started via `echocoding start`, communicates via Unix socket.
 */
import { startDaemon } from '../src/daemon/server.js';

startDaemon();
