<script lang="ts">
	import { onDestroy } from 'svelte';
	import CodeEditor from '$lib/CodeEditor.svelte';
	import ObjectTree from '$lib/ObjectTree.svelte';
	import StreamBlock from '$lib/StreamBlock.svelte';
	import type { DisplayMode } from '$lib/StreamBlock.svelte';
	import type { RunStatus, SnapshotNode, WorkerMessage } from '$lib/stream-types';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';

	type Block = Extract<WorkerMessage, { type: 'block' }>;
	const defaultSource = `type Packet = { id: number; label: string };

const shared: Packet = { id: 7, label: 'same identity' };
const wait = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(resolve, ms, value));

async function* telemetry() {
  yield await wait(900, { seq: 1, shared });
  yield await wait(1100, { seq: 2, shared });
  return await wait(850, { closed: true });
}

const first = wait(1450, { phase: 'indexed', shared });
const second = wait(3200, new Map([[shared, new Set([shared])]]));

const graph = {
  protocol: 'uneval-stream',
  shared,
  alias: shared,
  first,
  second,
  sequence: telemetry(),
  view: new Uint16Array([21, 34, 55]),
  generatedAt: new Date()
};
graph.shared.self = graph.shared as Packet & { self: Packet };

export default graph;`;

	let source = $state(defaultSource);
	let status = $state<RunStatus>('idle');
	let blocks: Block[] = $state.raw([]);
	let snapshot: SnapshotNode | undefined = $state.raw();
	let error = $state('');
	let elapsed = $state(0);
	let activeTab = $state('stream');
	let displayMode = $state<DisplayMode>('pretty');
	let worker: Worker | undefined;
	let runId = 0;
	let blockBytes = $derived(blocks.reduce((total, block) => total + block.bytes, 0));
	let running = $derived(status === 'compiling' || status === 'streaming');

	function createWorker() { return new Worker(new URL('../lib/stream.worker.ts', import.meta.url), { type: 'module' }); }
	function run() {
		worker?.terminate(); runId++; blocks = []; snapshot = undefined; error = ''; elapsed = 0; status = 'compiling'; activeTab = 'stream';
		worker = createWorker();
		const current = runId;
		worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
			if (data.runId !== current || current !== runId) return;
			elapsed = data.elapsed;
			if (data.type === 'status') status = data.status;
			else if (data.type === 'block') blocks = [...blocks, data];
			else if (data.type === 'snapshot') snapshot = data.snapshot;
			else if (data.type === 'error') { status = 'error'; error = data.message; }
			else if (data.type === 'done') status = 'complete';
		};
		worker.onerror = (event) => { if (current === runId) { status = 'error'; error = event.message; } };
		worker.postMessage({ runId: current, source });
	}
	function stop() { worker?.terminate(); worker = undefined; runId++; status = 'stopped'; }
	onDestroy(() => worker?.terminate());
</script>

<Tooltip.Provider delayDuration={300}>
	<main>
		<header class="topbar">
			<div class="brand"><span class="brand-mark">d/</span><div><h1>unevalStream</h1><p>executable graph transport · protocol lab</p></div></div>
			<div class="header-stats"><Badge variant="outline">worker isolate</Badge><span>{blocks.length} blocks</span><span>{blockBytes} bytes</span><span>{elapsed.toFixed(0)} ms</span></div>
		</header>
		<Separator />
		<section class="workspace">
			<section class="panel editor-panel" aria-label="Source editor">
				<div class="panel-header"><div class="file-label"><span class="ts-icon">TS</span><strong>example.ts</strong><span class="dirty-dot" aria-label="Editable"></span></div>
					<div class="actions"><span class={`status status-${status}`}><i></i>{status}</span>
					{#if running}<Button variant="outline" size="sm" onclick={stop}>■ Stop</Button>{/if}
					<Button size="sm" onclick={run} disabled={running}>▶ Run <kbd>⌘↵</kbd></Button></div></div>
				<div class="editor-wrap"><CodeEditor bind:value={source} onrun={run} /></div>
				<footer class="editor-footer"><span>TypeScript · ES2022</span><span>export default graph</span><span>isolated worker</span></footer>
			</section>

			<section class="panel results-panel" aria-label="Stream output">
				<Tabs.Root bind:value={activeTab} class="results-tabs">
					<div class="result-header"><Tabs.List variant="line"><Tabs.Trigger value="stream">Stream <Badge variant="secondary">{blocks.length}</Badge></Tabs.Trigger><Tabs.Trigger value="object">Object graph {#if snapshot}<span class="live-dot"></span>{/if}</Tabs.Trigger></Tabs.List><div class="result-header-tools"><span class="protocol">chronological · source before eval</span><div class="display-toggle" role="group" aria-label="Stream source display mode"><Button variant={displayMode === 'pretty' ? 'secondary' : 'ghost'} size="xs" aria-pressed={displayMode === 'pretty'} onclick={() => displayMode = 'pretty'}>Pretty</Button><Button variant={displayMode === 'raw' ? 'secondary' : 'ghost'} size="xs" aria-pressed={displayMode === 'raw'} onclick={() => displayMode = 'raw'}>Raw</Button></div></div></div>
					<Tabs.Content value="stream" class="tab-content"><ScrollArea class="result-scroll">
						<div class="timeline">
							{#each blocks as block (block.kind + block.index)}<StreamBlock {block} mode={displayMode} newest={block === blocks.at(-1)} />{:else}<div class="empty"><span>∿</span><h2>Awaiting protocol blocks</h2><p>Run <code>example.ts</code> to emit the head expression and asynchronous tails.</p><Button variant="outline" onclick={run}>Run example</Button></div>{/each}
							{#if error}<div class="error-box"><strong>Worker error</strong><pre>{error}</pre></div>{/if}
							{#if running && blocks.length}<div class="pending-row"><i></i> waiting for the next async settlement…</div>{/if}
						</div>
					</ScrollArea></Tabs.Content>
					<Tabs.Content value="object" class="tab-content"><ScrollArea class="result-scroll"><div class="object-pane">
						{#if snapshot}<div class="object-note"><span>LIVE SNAPSHOT</span> Stable identities preserve aliases and cycles. For inspection only, the worker drains reconstructed client iterators into a capped visualization sidecar; raw blocks and server backpressure are unchanged.</div><ObjectTree node={snapshot} />{:else}<div class="empty"><span>&#123; &#125;</span><h2>No reconstructed graph</h2><p>The object view updates after the head and every evaluated tail block.</p></div>{/if}
					</div></ScrollArea></Tabs.Content>
				</Tabs.Root>
			</section>
		</section>
		<footer class="page-footer"><span><i class="green"></i> head evaluates in worker realm</span><span><i class="amber"></i> tails evaluate in arrival order</span><span class="spacer"></span><a href="https://github.com/sveltejs/devalue" target="_blank" rel="noreferrer">devalue ↗</a></footer>
	</main>
</Tooltip.Provider>
