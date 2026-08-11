<script lang="ts">
	import { EditorState } from '@codemirror/state';
	import { javascript } from '@codemirror/lang-javascript';
	import { EditorView, lineNumbers } from '@codemirror/view';
	import { onMount } from 'svelte';
	import { javascriptSyntaxHighlighting } from '$lib/codemirror';

	interface Props {
		source: string;
		lineNumbers?: boolean;
		label?: string;
	}

	let { source, lineNumbers: showLineNumbers = false, label = 'JavaScript source' }: Props = $props();
	let host: HTMLDivElement;
	let view: EditorView | undefined;

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: source,
				extensions: [
					javascript(),
					javascriptSyntaxHighlighting,
					...(showLineNumbers ? [lineNumbers()] : []),
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.lineWrapping,
					EditorView.theme({
						'&': { height: 'auto', backgroundColor: 'transparent' },
						'.cm-scroller': { overflow: 'visible' }
					})
				]
			})
		});

		return () => view?.destroy();
	});

	$effect(() => {
		if (!view || source === view.state.doc.toString()) return;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
	});
</script>

<div class="code-viewer" bind:this={host} aria-label={label}></div>
