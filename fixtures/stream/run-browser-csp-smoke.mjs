import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const debug_port = 9300 + process.pid % 500;
const profile = `/private/var/folders/k9/jpx5wht94895p_2wxrwwl7gw0000gn/T/opencode/devalue-browser-${process.pid}`;
const server = spawn(process.execPath, ['fixtures/stream/browser-csp-smoke.mjs', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const lines = createInterface({ input: server.stdout });

async function with_timeout(label, operation, milliseconds = 15_000) {
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function first_line() {
	for await (const line of lines) return line;
	throw new Error('browser smoke server exited before listening');
}

async function retry(label, callback) {
	let error;
	for (let i = 0; i < 200; i++) {
		try { return await callback(); } catch (caught) { error = caught; }
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`${label} failed`, { cause: error });
}

class Cdp {
	constructor(url) {
		this.next = 1;
		this.pending = new Map();
		this.socket = new WebSocket(url);
		this.socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (!message.id) return;
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (!pending) return;
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		};
	}
	async open() {
		if (this.socket.readyState === WebSocket.OPEN) return;
		await once(this.socket, 'open');
	}
	call(method, params = {}) {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}
	close() {
		this.socket.close();
	}
}

function assert(value, message) {
	if (!value) throw new Error(message);
}

let browser;
let cdp;
try {
	const origin = await with_timeout('server startup', first_line());
	browser = spawn(chrome, [
		'--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
		`--remote-debugging-port=${debug_port}`, `--user-data-dir=${profile}`,
		`${origin}/stream`
	], { stdio: 'ignore' });
	const targets = await retry('Chrome CDP target', async () => {
		const response = await fetch(`http://127.0.0.1:${debug_port}/json/list`);
		if (!response.ok) throw new Error(`CDP target response ${response.status}`);
		const values = await response.json();
		if (!values.some((value) => value.type === 'page')) throw new Error('no page target');
		return values;
	});
	const page = targets.find((target) => target.type === 'page');
	cdp = new Cdp(page.webSocketDebuggerUrl);
	await cdp.open();
	await cdp.call('Runtime.enable');
	const result = await with_timeout('stream assertions', retry('browser-visible stream results', async () => {
		const evaluation = await cdp.call('Runtime.evaluate', { expression: 'globalThis.results', returnByValue: true });
		if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text);
		if (evaluation.result.value === undefined) throw new Error('results pending');
		return evaluation.result.value;
	}));
	assert(!result.error, `browser page failed: ${result.error}`);
	assert(result.headReady === true, 'head was not available before slow release');
	assert(result.fast === 'head-ready', 'fast head value mismatch');
	assert(result.slowText === 'slow-ready' && result.slowShared === true, 'slow value or shared identity mismatch');
	assert(result.sharedCollection === true, 'Map/head descendant identity mismatch');
	assert(JSON.stringify(result.sequenceIndices) === '[1,2]' && result.sequenceShared === true, 'finite sequence mismatch');
	assert(result.rejection === 'expected-browser-rejection', 'early rejection mismatch');
	assert(JSON.stringify(result.instruction) === '{"type":"reference","index":7,"value":"ordinary-data"}', 'instruction-shaped data mismatch');
	assert(JSON.stringify(result.numeric) === '["0","12","001"]', 'numeric key order mismatch');
	assert(result.unicode === '😀\ud800', 'Unicode/lone-surrogate mismatch');
	assert(result.closing === '</script><script>globalThis.injected=true</script>' && result.injected === false, 'script-closing escaping mismatch');
	assert(result.custom === 'token-local', 'identifier-token/trailing-comment custom source mismatch');
	assert(result.sessionDeleted === true, 'client session entry was retained');
	assert(result.events.errors.length === 0 && result.events.rejections.length === 0 && result.events.csp.length === 0, `unexpected browser or CSP event: ${JSON.stringify(result.events)}`);

	await cdp.call('Page.enable');
	await cdp.call('Page.navigate', { url: `${origin}/abandon` });
	await with_timeout('abandonment head', retry('browser-visible abandonment head', async () => {
		const evaluation = await cdp.call('Runtime.evaluate', { expression: 'globalThis.headReady', returnByValue: true });
		if (evaluation.result.value !== true) throw new Error('head pending');
		return true;
	}));
	await cdp.call('Page.navigate', { url: `${origin}/` });
	const status = await retry('server abandonment cleanup', async () => {
		const response = await fetch(`${origin}/status`);
		const value = await response.json();
		if (value.abandonment.returns !== 1 || value.abandonment.cancels !== 1 || value.abandonment.closed < 1) throw new Error('cleanup pending');
		return value;
	});
	console.log(JSON.stringify({
		browser: 'Google Chrome headless',
		stream: { assertions: 14, result },
		abandonment: status.abandonment
	}));
} finally {
	cdp?.close();
	const browser_exit = browser?.exitCode === null ? once(browser, 'exit') : undefined;
	const server_exit = server.exitCode === null ? once(server, 'exit') : undefined;
	if (browser?.exitCode === null) browser.kill('SIGTERM');
	if (server.exitCode === null) server.kill('SIGTERM');
	await Promise.allSettled([browser_exit, server_exit].filter(Boolean));
	await rm(profile, { recursive: true, force: true });
}
