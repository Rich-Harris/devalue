#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';

if (process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'exit') process.exit(7);

if (process.env.DEVALUE_BROWSER_TEST_CHILD_MODE === 'stubborn') {
	const argument = process.argv.find((value) => value.startsWith('--user-data-dir='));
	if (!argument) throw new Error('missing profile argument');
	writeFileSync(process.env.DEVALUE_BROWSER_TEST_PID_FILE, String(process.pid));
	process.on('SIGTERM', () => {});
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
