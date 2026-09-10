import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';

const test = suite('browser smoke harness');
const runner = fileURLToPath(new URL('../fixtures/stream/run-browser-csp-smoke.mjs', import.meta.url));
const child_fixture = fileURLToPath(new URL('../fixtures/stream/browser-harness-test.mjs', import.meta.url));
const server_fixture = fileURLToPath(new URL('../fixtures/stream/browser-csp-smoke.mjs', import.meta.url));

async function temporary_directory() {
	return mkdtemp(join(tmpdir(), 'devalue-browser-harness-test-'));
}

function run(cwd, environment) {
	return spawnSync(process.execPath, [runner], {
		cwd,
		env: { ...process.env, DEVALUE_BROWSER_HARNESS_TIMEOUT_MS: '500', ...environment },
		encoding: 'utf8',
		timeout: 8_000
	});
}

async function no_profiles(directory) {
	const entries = await readdir(directory);
	assert.equal(entries.filter((entry) => entry.startsWith('devalue-browser-')), []);
}

async function fake_browser(directory) {
	const executable = join(directory, 'fake-browser');
	await copyFile(child_fixture, executable);
	await chmod(executable, 0o755);
	return executable;
}

test('reports a missing browser from any cwd and removes only its created profile', async () => {
	const parent = await temporary_directory();
	const cwd = join(parent, 'unrelated-cwd');
	await mkdir(cwd);
	try {
		const result = run(cwd, {
			TMPDIR: parent,
			CHROME_PATH: join(parent, 'browser-does-not-exist')
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Chrome failed to start: .*ENOENT/);
		await no_profiles(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('reports an immediate browser exit without waiting for a watchdog', async () => {
	const parent = await temporary_directory();
	try {
		const executable = await fake_browser(parent);
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: executable,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'exit'
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Chrome exited early \(code 7\)/);
		await no_profiles(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('reports an early server exit without launching Chrome', async () => {
	const parent = await temporary_directory();
	try {
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: join(parent, 'browser-must-not-launch'),
			DEVALUE_BROWSER_SERVER_PATH: child_fixture,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'exit'
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /browser smoke server (closed stdout before listening|exited early \(code 7\))/);
		assert.not.match(result.stderr, /Chrome failed to start/);
		await no_profiles(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('force-terminates only its stubborn browser child and removes its profile', async () => {
	const parent = await temporary_directory();
	const pid_file = join(parent, 'child.pid');
	try {
		const executable = await fake_browser(parent);
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: executable,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'stubborn',
			DEVALUE_BROWSER_HARNESS_TIMEOUT_MS: '200',
			DEVALUE_BROWSER_TEST_PID_FILE: pid_file
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Chrome DevTools endpoint timed out/);
		const pid = Number(await readFile(pid_file, 'utf8'));
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		await no_profiles(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('reports CDP disconnection without waiting for the harness watchdog', async () => {
	const parent = await temporary_directory();
	try {
		const executable = await fake_browser(parent);
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: executable,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'disconnect'
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /CDP (disconnected|WebSocket closed before opening)/);
		await no_profiles(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('shuts down a server with an abandonment response parked before release', async () => {
	const server = spawn(process.execPath, [server_fixture, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
	let request;
	try {
		const origin = await Promise.race([
			new Promise((resolve, reject) => {
				let text = '';
				server.stdout.on('data', (chunk) => {
					text += chunk;
					const newline = text.indexOf('\n');
					if (newline !== -1) resolve(text.slice(0, newline).trim());
				});
				server.once('error', reject);
				server.once('exit', (code, signal) => reject(new Error(`server exited before listening: ${code ?? signal}`)));
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error('server startup timed out')), 2_000))
		]);
		request = fetch(`${origin}/abandon`);
		const response = await Promise.race([
			request,
			new Promise((_, reject) => setTimeout(() => reject(new Error('abandonment head timed out')), 2_000))
		]);
		assert.is(response.status, 200);
		server.kill('SIGTERM');
		const result = await Promise.race([
			new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
			new Promise((_, reject) => setTimeout(() => reject(new Error('server shutdown timed out')), 4_000))
		]);
		assert.equal(result, { code: 0, signal: null });
	} finally {
		if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
		await request?.catch(() => {});
	}
});

test.run();
