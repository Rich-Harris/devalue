<script lang="ts">
	import type { SnapshotNode } from './stream-types';
	import Self from './ObjectTree.svelte';
	import { Badge } from '$lib/components/ui/badge';

	interface Props { node: SnapshotNode; name?: string; depth?: number; }
	let { node, name = 'root', depth = 0 }: Props = $props();
	let open = $state(true);
	let expandable = $derived(Boolean(node.children?.length));
	let stateVariant = $derived<'secondary' | 'destructive' | 'outline'>(node.state === 'pending' || node.state === 'streaming' ? 'secondary' : node.state === 'rejected' || node.state === 'error' ? 'destructive' : 'outline');
</script>

<div class="tree-node">
	<div class="tree-row">
		{#if expandable}
			<button class="tree-toggle" onclick={() => open = !open} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}>{open ? '−' : '+'}</button>
		{:else}<span class="tree-spacer"></span>{/if}
		<span class="tree-key">{name}</span><span class="punct">:</span>
		<span class={`tree-value kind-${node.kind.toLowerCase()}`}>{node.ref ? `↗ #${node.ref}` : node.value ?? node.kind}</span>
		{#if node.id}<Badge variant="outline" class="identity">#{node.id}</Badge>{/if}
		{#if node.state}<Badge variant={stateVariant} class={`state state-${node.state}`}><i></i>{node.state}</Badge>{/if}
		{#if node.meta}<span class="tree-meta">{node.meta}</span>{/if}
	</div>
	{#if open && node.children}
		<div class="tree-children">
			{#each node.children as child, index (`${child.key}-${index}`)}
				<Self node={child.value} name={child.key} depth={depth + 1} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.state :global(i) { display: inline-block; width: 0.4rem; height: 0.4rem; border-radius: 999px; background: currentColor; }
	.state-streaming { color: var(--color-amber-700); }
	.state-streaming :global(i) { animation: pulse 1.2s ease-in-out infinite; }
	.state-complete, .state-fulfilled { color: var(--color-emerald-700); }
	.state-error, .state-rejected { color: var(--color-red-700); }
	@keyframes pulse { 50% { opacity: 0.3; } }
</style>
