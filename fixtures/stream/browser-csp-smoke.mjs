import http from 'node:http';
import { unevalStream } from '../../index.js';

const port = Number(process.argv[2] ?? 41739);
const host = '127.0.0.1';
const nonce = 'devalue-stream-smoke';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((fulfil, fail) => {
		resolve = fulfil;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function script(source) {
	return `<script nonce="${nonce}">${source}</script>\n`;
}

function headers(response) {
	response.writeHead(200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; object-src 'none'; base-uri 'none'`,
		'x-content-type-options': 'nosniff'
	});
}

const release = deferred();
let released = false;
const abandonment = { requests: 0, returns: 0, cancels: 0, closed: 0 };

class CustomValue {
	constructor(value) {
		this.value = value;
	}
}

async function serve_stream(response) {
	const slow = deferred();
	const failed = deferred();
	const sequence_gate = deferred();
	const shared = { label: 'shared-😀' };
	async function* sequence() {
		await sequence_gate.promise;
		yield { index: 1, shared };
		yield { index: 2, shared };
		return 'complete';
	}
	const root_value = {
		fast: 'head-ready',
		shared,
		collection: new Map([[shared, { shared }]]),
		slow: slow.promise,
		sequence: sequence(),
		rejected: failed.promise,
		instruction: { type: 'reference', index: 7, value: 'ordinary-data' },
		numeric: { '0': 'zero', '12': 'twelve', '001': 'leading' },
		unicode: '😀\ud800',
		closing: '</script><script>globalThis.injected=true</script>',
		custom: new CustomValue({ label: 'token-local' })
	};
	const result = await unevalStream(root_value, (value, js) => {
		if (!(value instanceof CustomValue)) return;
		const local = js.identifier();
		return js`(()=>{const ${local}=${value.value};return {value:${local}}})()// complete custom expression`;
	}, { id: 'browser-csp-smoke' });
	headers(response);
	response.write('<!doctype html><meta charset="utf-8"><title>devalue CSP stream</title>');
	response.write(script(`globalThis.events={errors:[],rejections:[],csp:[]};addEventListener('error',e=>events.errors.push(String(e.error??e.message)));addEventListener('unhandledrejection',e=>events.rejections.push(String(e.reason)));addEventListener('securitypolicyviolation',e=>events.csp.push(e.violatedDirective));`));
	response.write(script(`globalThis.data=(${result.head});globalThis.headReady=data.fast==='head-ready'&&Object.hasOwn(globalThis.__d,'browser-csp-smoke');fetch('/release',{method:'POST'});`));
	await release.promise;
	slow.resolve({ shared, again: shared, text: 'slow-ready' });
	failed.reject('expected-browser-rejection');
	sequence_gate.resolve();
	for await (const block of result.tail) {
		response.write(script(block));
		await new Promise((resolve) => setImmediate(resolve));
	}
	response.write(script(`globalThis.done=(async()=>{let sequenceValues=[];for await(const value of data.sequence)sequenceValues.push(value);let rejection;try{await data.rejected}catch(error){rejection=error}let slow=await data.slow;let sessionDeleted=!globalThis.__d||!Object.hasOwn(globalThis.__d,'browser-csp-smoke');return {headReady,fast:data.fast,slowText:slow.text,slowShared:slow.shared===data.shared&&slow.again===data.shared,sharedCollection:[...data.collection.keys()][0]===data.shared&&data.collection.get(data.shared).shared===data.shared,sequenceIndices:sequenceValues.map(value=>value.index),sequenceShared:sequenceValues.every(value=>value.shared===data.shared),rejection,instruction:data.instruction,numeric:Object.keys(data.numeric),unicode:data.unicode,closing:data.closing,custom:data.custom.value.label,injected:globalThis.injected===true,sessionDeleted,events}})().then(value=>{globalThis.results=value},error=>{globalThis.results={error:String(error),events}});`));
	response.end();
}

async function serve_abandonment(response) {
	abandonment.requests++;
	const pull = deferred();
	const iterable = {
		[Symbol.asyncIterator]() { return this; },
		next() { return pull.promise; },
		return() { abandonment.returns++; return { done: true }; }
	};
	const value = { source: iterable };
	const result = await unevalStream(value, (candidate, js) => candidate === value && ({
		type: 'async-sequence', source: iterable,
		construct: () => js`({})`, next: () => js``, complete: () => js``, error: () => js``,
		cancel() { abandonment.cancels++; }
	}), { id: 'browser-csp-abandonment' });
	headers(response);
	response.write('<!doctype html><meta charset="utf-8"><title>devalue abandoned stream</title>');
	response.write(script(`globalThis.data=(${result.head});globalThis.headReady=true;location.href='/';`));
	let closed = false;
	response.on('close', () => {
		if (closed) return;
		closed = true;
		abandonment.closed++;
		void result.tail.return().finally(() => pull.resolve({ done: true }));
	});
	try {
		for await (const block of result.tail) response.write(script(block));
	} catch {
		// The browser deliberately abandons this response.
	}
}

const server = http.createServer((request, response) => {
	const url = new URL(request.url ?? '/', `http://${host}:${port}`);
	if (url.pathname === '/') {
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		response.end('<!doctype html><meta charset="utf-8"><title>devalue browser harness</title><body>browser harness</body>');
		return;
	}
	if (url.pathname === '/stream') {
		void serve_stream(response).catch((error) => {
			if (!response.headersSent) response.writeHead(500);
			response.end(String(error?.stack ?? error));
		});
		return;
	}
	if (url.pathname === '/release') {
		if (!released) {
			released = true;
			release.resolve();
		}
		response.writeHead(204, { 'cache-control': 'no-store' });
		response.end();
		return;
	}
	if (url.pathname === '/abandon') {
		void serve_abandonment(response).catch(() => {});
		return;
	}
	if (url.pathname === '/status') {
		response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		response.end(JSON.stringify({ released, abandonment }));
		return;
	}
	response.writeHead(404);
	response.end('not found');
});

server.listen(port, host, () => console.log(`http://${host}:${server.address().port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => server.close(() => process.exit(0)));
}
