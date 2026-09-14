import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

async function no_profiles(directory, preserved = []) {
	const entries = await readdir(directory);
	assert.equal(entries.filter((entry) => entry.startsWith('devalue-browser-')).sort(), preserved.sort());
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

for (const setup_delay of [0, 500]) test(`waits for ${setup_delay}ms stubborn browser setup before force-terminating only its child`, async () => {
	const parent = await temporary_directory();
	const pid_file = join(parent, 'child.pid');
	const ready_file = join(parent, 'child.ready');
	const sigterm_file = join(parent, 'child.sigterm');
	const caller_profile = 'devalue-browser-caller-owned';
	const sentinel_file = join(parent, caller_profile, 'sentinel');
	try {
		await mkdir(join(parent, caller_profile));
		await writeFile(sentinel_file, 'caller-owned');
		const executable = await fake_browser(parent);
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: executable,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'stubborn',
			DEVALUE_BROWSER_TEST_SETUP_DELAY_MS: String(setup_delay),
			DEVALUE_BROWSER_HARNESS_TIMEOUT_MS: '200',
			DEVALUE_BROWSER_TEST_READINESS_TIMEOUT_MS: '1500',
			DEVALUE_BROWSER_TEST_PID_FILE: pid_file,
			DEVALUE_BROWSER_TEST_READY_FILE: ready_file,
			DEVALUE_BROWSER_TEST_SIGTERM_FILE: sigterm_file
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Chrome DevTools endpoint timed out/, result.stderr);
		const pid = Number(await readFile(pid_file, 'utf8'));
		assert.is(Number(await readFile(ready_file, 'utf8')), pid);
		assert.is(Number(await readFile(sigterm_file, 'utf8')), pid);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		assert.is(await readFile(sentinel_file, 'utf8'), 'caller-owned');
		await no_profiles(parent, [caller_profile]);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('times out in the readiness phase and force-terminates a browser that never publishes ready', async () => {
	const parent = await temporary_directory();
	const pid_file = join(parent, 'child.pid');
	const ready_file = join(parent, 'child.ready');
	const sigterm_file = join(parent, 'child.sigterm');
	try {
		const executable = await fake_browser(parent);
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: executable,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'never-ready',
			DEVALUE_BROWSER_HARNESS_TIMEOUT_MS: '200',
			DEVALUE_BROWSER_TEST_READINESS_TIMEOUT_MS: '300',
			DEVALUE_BROWSER_TEST_PID_FILE: pid_file,
			DEVALUE_BROWSER_TEST_READY_FILE: ready_file,
			DEVALUE_BROWSER_TEST_SIGTERM_FILE: sigterm_file
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Chrome test readiness timed out after 300ms/);
		const pid = Number(await readFile(pid_file, 'utf8'));
		assert.is(Number(await readFile(sigterm_file, 'utf8')), pid);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		let readiness_error;
		try {
			await readFile(ready_file, 'utf8');
		} catch (error) {
			readiness_error = error;
		}
		assert.is(readiness_error?.code, 'ENOENT');
		await no_profiles(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('reports an early browser exit during readiness and removes its profile', async () => {
	const parent = await temporary_directory();
	try {
		const executable = await fake_browser(parent);
		const result = run(process.cwd(), {
			TMPDIR: parent,
			CHROME_PATH: executable,
			DEVALUE_BROWSER_TEST_CHILD_MODE: 'exit',
			DEVALUE_BROWSER_TEST_READY_FILE: join(parent, 'never-created.ready')
		});
		assert.is(result.signal, null, result.error?.message);
		assert.is(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Chrome exited early \(code 7\)/);
		assert.not.match(result.stderr, /test readiness timed out/);
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
