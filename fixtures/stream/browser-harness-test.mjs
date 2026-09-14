#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';

if (process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'exit') process.exit(7);

if (process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'stubborn' || process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'never-ready') {
	const argument = process.argv.find((value) => value.startsWith('--user-data-dir='));
	if (!argument) throw new Error('missing profile argument');
	const setup_delay = Number(process.env.DEVALUE_BROWSER_TEST_SETUP_DELAY_MS ?? 0);
	if (!Number.isFinite(setup_delay) || setup_delay < 0 || setup_delay > 2_000) {
		throw new Error('DEVALUE_BROWSER_TEST_SETUP_DELAY_MS must be a finite duration from 0 to 2000');
	}
	if (setup_delay > 0) await new Promise((resolve) => setTimeout(resolve, setup_delay));
	process.on('SIGTERM', () => {
		writeFileSync(process.env.DEVALUE_BROWSER_TEST_SIGTERM_FILE, String(process.pid));
	});
	writeFileSync(process.env.DEVALUE_BROWSER_TEST_PID_FILE, String(process.pid));
	if (process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'stubborn') {
		writeFileSync(process.env.DEVALUE_BROWSER_TEST_READY_FILE, String(process.pid));
	}
	setInterval(() => {}, 1_000);
}

if (process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'disconnect') {
	const argument = process.argv.find((value) => value.startsWith('--user-data-dir='));
	if (!argument) throw new Error('missing profile argument');
	const profile = argument.slice('--user-data-dir='.length);
	const page_url = process.argv.at(-1);
	const server = http.createServer((request, response) => {
		if (request.url !== '/json/list') {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify([{ type: 'page', url: page_url, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/fixture` }]));
	});
	server.on('upgrade', (request, socket) => {
		const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		setImmediate(() => socket.destroy());
	});
	server.listen(0, '127.0.0.1', () => {
		writeFileSync(`${profile}/DevToolsActivePort`, `${server.address().port}\n/devtools/browser/fixture\n`);
	});
	process.once('SIGTERM', () => server.close());
}
