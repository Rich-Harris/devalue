<script lang="ts">
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { javascript } from '@codemirror/lang-javascript';
	import { bracketMatching } from '@codemirror/language';
	import { onMount } from 'svelte';
	import { javascriptSyntaxHighlighting } from '$lib/codemirror';

	interface Props { value?: string; onrun: () => void; }
	let { value = $bindable(''), onrun }: Props = $props();
	let host: HTMLDivElement;
	let view: EditorView | undefined;
	let applying = false;

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [lineNumbers(), javascript({ typescript: true }), javascriptSyntaxHighlighting, bracketMatching(), EditorView.lineWrapping, keymap.of([{ key: 'Mod-Enter', run: () => { onrun(); return true; } }]), EditorView.updateListener.of((update) => {
					if (update.docChanged && !applying) value = update.state.doc.toString();
				}), EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } })]
			})
		});
		return () => view?.destroy();
	});

	$effect(() => {
		if (!view || value === view.state.doc.toString()) return;
		applying = true;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		applying = false;
	});
</script>

<div class="editor-shell" bind:this={host} aria-label="TypeScript editor for example.ts"></div>
