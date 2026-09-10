import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const navigation_delay = Number(process.env.DEVALUE_BROWSER_NAVIGATION_DELAY_MS ?? 0);
if (!Number.isFinite(navigation_delay) || navigation_delay < 0 || navigation_delay > 5_000) {
	throw new Error('DEVALUE_BROWSER_NAVIGATION_DELAY_MS must be a finite duration from 0 to 5000');
}
const harness_timeout = Number(process.env.DEVALUE_BROWSER_HARNESS_TIMEOUT_MS ?? 15_000);
if (!Number.isFinite(harness_timeout) || harness_timeout < 100 || harness_timeout > 30_000) {
	throw new Error('DEVALUE_BROWSER_HARNESS_TIMEOUT_MS must be a finite duration from 100 to 30000');
}

const fixture = process.env.DEVALUE_BROWSER_SERVER_PATH ?? fileURLToPath(new URL('./browser-csp-smoke.mjs', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'devalue-browser-'));
const children = [];

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function with_timeout(label, operation, milliseconds = harness_timeout) {
	let timer;
	return Promise.race([
		operation,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
		})
	]).finally(() => clearTimeout(timer));
}

function observe(child, label) {
	const state = { child, label, result: undefined };
	state.completion = new Promise((resolve) => {
		child.once('error', (error) => {
			state.result = { error };
			resolve(state.result);
		});
		child.once('exit', (code, signal) => {
			if (state.result) return;
			state.result = { code, signal };
			resolve(state.result);
		});
	});
	children.push(state);
	return state;
}

function exited(state) {
	const result = state.result;
	if (!result) return;
	if (result.error) throw new Error(`${state.label} failed to start: ${result.error.message}`, { cause: result.error });
	throw new Error(`${state.label} exited early (${result.signal ? `signal ${result.signal}` : `code ${result.code}`})`);
}

async function wait_for(label, callback, states = [], milliseconds = harness_timeout) {
	const deadline = Date.now() + milliseconds;
	let cause;
	while (Date.now() < deadline) {
		for (const state of states) exited(state);
		try {
			return await callback(Math.max(1, deadline - Date.now()));
		} catch (error) {
			if (error?.terminal) throw error;
			cause = error;
		}
		await delay(25);
	}
	for (const state of states) exited(state);
	throw new Error(`${label} timed out after ${milliseconds}ms`, { cause });
}

function first_line(state) {
	return new Promise((resolve, reject) => {
		let text = '';
		const on_data = (chunk) => {
			text += chunk;
			const newline = text.indexOf('\n');
			if (newline === -1) return;
			cleanup();
			resolve(text.slice(0, newline).trim());
		};
		const on_end = () => {
			cleanup();
			reject(new Error(`${state.label} closed stdout before listening`));
		};
		const cleanup = () => {
			state.child.stdout.off('data', on_data);
			state.child.stdout.off('end', on_end);
		};
		state.child.stdout.on('data', on_data);
		state.child.stdout.once('end', on_end);
	});
}

async function terminate(state) {
	if (!state || state.result) return;
	state.child.kill('SIGTERM');
	if (await Promise.race([state.completion.then(() => true), delay(1_500).then(() => false)])) return;
	state.child.kill('SIGKILL');
	if (!await Promise.race([state.completion.then(() => true), delay(1_500).then(() => false)])) {
		throw new Error(`${state.label} did not exit after SIGKILL`);
	}
}

class Cdp {
	constructor(url) {
		this.next = 1;
		this.pending = new Map();
		this.error = undefined;
		this.socket = new WebSocket(url);
		this.socket.addEventListener('message', (event) => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch (error) {
				this.fail(error);
				return;
			}
			if (!message.id) return;
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (!pending) return;
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
		this.socket.addEventListener('error', (event) => this.fail(event.error ?? new Error('CDP WebSocket error')));
		this.socket.addEventListener('close', () => this.fail(new Error('CDP WebSocket closed')));
	}
	fail(error) {
		if (!this.error) {
			this.error = new Error(`CDP disconnected: ${error.message}`, { cause: error });
			this.error.terminal = true;
		}
		for (const pending of this.pending.values()) pending.reject(this.error);
		this.pending.clear();
	}
	async open() {
		if (this.socket.readyState === WebSocket.OPEN) return;
		if (this.socket.readyState !== WebSocket.CONNECTING) throw new Error('CDP WebSocket is not open');
		await with_timeout('CDP WebSocket open', new Promise((resolve, reject) => {
			this.socket.addEventListener('open', resolve, { once: true });
			this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
			this.socket.addEventListener('close', () => reject(new Error('CDP WebSocket closed before opening')), { once: true });
		}), Math.min(harness_timeout, 5_000));
	}
	call(method, params = {}) {
		if (this.error) return Promise.reject(this.error);
		if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`cannot call ${method}: CDP WebSocket is not open`));
		const id = this.next++;
		const operation = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
		return with_timeout(`CDP ${method}`, operation, Math.min(harness_timeout, 5_000)).finally(() => this.pending.delete(id));
	}
	close() {
		if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
	}
}

async function get_json(url, milliseconds) {
	const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(milliseconds, 1_000)) });
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return response.json();
}

function assert(value, message) {
	if (!value) throw new Error(message);
}

let cdp;
let primary_error;
try {
	const server = observe(spawn(process.execPath, [fixture, '0'], {
		stdio: ['ignore', 'pipe', 'inherit']
	}), 'browser smoke server');
	const origin = await with_timeout('server startup', Promise.race([
		first_line(server),
		server.completion.then(() => exited(server))
	]));
	const browser = observe(spawn(chrome, [
		'--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
		'--remote-debugging-port=0', `--user-data-dir=${profile}`,
		`${origin}/stream`
	], { stdio: 'ignore' }), 'Chrome');
	const endpoint = await wait_for('Chrome DevTools endpoint', async () => {
		const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
		if (!/^\d+$/.test(port) || !path?.startsWith('/')) throw new Error('invalid DevToolsActivePort');
		return { port: Number(port), path };
	}, [browser]);
	const page = await wait_for('Chrome page target', async (remaining) => {
		const values = await get_json(`http://127.0.0.1:${endpoint.port}/json/list`, remaining);
		const target = values.find((value) => {
			if (value.type !== 'page') return false;
			const url = new URL(value.url);
			return url.origin === origin && url.pathname === '/stream';
		});
		if (!target) throw new Error(`no ${origin}/stream page target`);
		return target;
	}, [browser]);
	cdp = new Cdp(page.webSocketDebuggerUrl);
	await Promise.race([cdp.open(), browser.completion.then(() => exited(browser))]);
	await cdp.call('Runtime.enable');
	const result = await wait_for('browser-visible stream results', async () => {
		const evaluation = await cdp.call('Runtime.evaluate', { expression: 'globalThis.results', returnByValue: true });
		if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text);
		if (evaluation.result.value === undefined) throw new Error('results pending');
		return evaluation.result.value;
	}, [browser]);
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
	if (navigation_delay > 0) await delay(navigation_delay);
	const expected_origin = JSON.stringify(origin);
	await wait_for('browser-visible abandonment head', async () => {
		const evaluation = await cdp.call('Runtime.evaluate', {
			expression: `location.origin===${expected_origin}&&location.pathname==='/abandon'&&globalThis.abandonmentHeadReady===true`,
			returnByValue: true
		});
		if (evaluation.exceptionDetails || evaluation.result.value !== true) throw new Error('URL-bound abandonment head pending');
		return true;
	}, [browser]);
	await cdp.call('Page.navigate', { url: `${origin}/` });
	const status = await wait_for('server abandonment cleanup', async (remaining) => {
		const value = await get_json(`${origin}/status`, remaining);
		const counts = value.abandonment;
		if (counts.requests !== 1 || counts.returns !== 1 || counts.cancels !== 1 || counts.closed !== 1) {
			throw new Error(`cleanup pending: ${JSON.stringify(counts)}`);
		}
		return value;
	}, [server, browser]);
	const version = await cdp.call('Browser.getVersion');
	console.log(JSON.stringify({
		browser: version.product,
		stream: { assertions: 14, result },
		abandonment: status.abandonment
	}));
} catch (error) {
	primary_error = error;
	throw error;
} finally {
	cdp?.close();
	const cleanup = await Promise.allSettled([...children].reverse().map(terminate));
	const profile_cleanup = await Promise.allSettled([rm(profile, { recursive: true, force: true })]);
	if (!primary_error) {
		const failure = cleanup.find((result) => result.status === 'rejected');
		if (failure) throw failure.reason;
		if (profile_cleanup[0].status === 'rejected') throw profile_cleanup[0].reason;
	}
}
