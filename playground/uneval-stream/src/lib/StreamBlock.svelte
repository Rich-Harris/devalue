<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import CodeViewer from '$lib/CodeViewer.svelte';
	import { formatSource } from '$lib/format-source';
	interface Block { kind: 'head' | 'tail'; index: number; source: string; bytes: number; elapsed: number; }
	export type DisplayMode = 'pretty' | 'raw';
	interface Props { block: Block; newest?: boolean; mode: DisplayMode; }
	let { block, newest = false, mode }: Props = $props();
	let open = $state(true);
	let copied = $state(false);
	let title = $derived(block.kind === 'head' ? 'HEAD / expression' : `TAIL ${String(block.index).padStart(2, '0')}`);
	let prettySource = $derived(formatSource(block.source));

	async function copy(source: string) { await navigator.clipboard.writeText(source); copied = true; setTimeout(() => copied = false, 1200); }
</script>

<article class:latest={newest} class="stream-block">
	<header>
		<button class="block-toggle" onclick={() => open = !open} aria-expanded={open}><span>{open ? '▾' : '▸'}</span><strong>{title}</strong></button>
		{#if mode === 'pretty'}
			{#await prettySource}
				<div class="block-meta"><span class="formatting-state">formatting…</span><Badge variant="outline">{block.bytes} B</Badge><span>+{block.elapsed.toFixed(0)} ms</span><Tooltip.Root><Tooltip.Trigger><Button variant="ghost" size="icon-xs" onclick={() => copy(block.source)} aria-label={`Copy ${title}`}>{copied ? '✓' : '⧉'}</Button></Tooltip.Trigger><Tooltip.Content>{copied ? 'Copied' : 'Copy source'}</Tooltip.Content></Tooltip.Root></div>
			{:then formatted}
				<div class="block-meta"><Badge variant="outline">{block.bytes} B</Badge><span>+{block.elapsed.toFixed(0)} ms</span><Tooltip.Root><Tooltip.Trigger><Button variant="ghost" size="icon-xs" onclick={() => copy(formatted)} aria-label={`Copy ${title}`}>{copied ? '✓' : '⧉'}</Button></Tooltip.Trigger><Tooltip.Content>{copied ? 'Copied' : 'Copy source'}</Tooltip.Content></Tooltip.Root></div>
			{/await}
		{:else}
			<div class="block-meta"><Badge variant="outline">{block.bytes} B</Badge><span>+{block.elapsed.toFixed(0)} ms</span><Tooltip.Root><Tooltip.Trigger><Button variant="ghost" size="icon-xs" onclick={() => copy(block.source)} aria-label={`Copy ${title}`}>{copied ? '✓' : '⧉'}</Button></Tooltip.Trigger><Tooltip.Content>{copied ? 'Copied' : 'Copy source'}</Tooltip.Content></Tooltip.Root></div>
		{/if}
	</header>
	{#if open}
		{#if mode === 'pretty'}
			{#await prettySource}<CodeViewer source={block.source} label={`${title} source`} />{:then formatted}<CodeViewer source={formatted} label={`${title} source`} />{/await}
		{:else}<CodeViewer source={block.source} label={`${title} source`} />{/if}
	{/if}
</article>
