<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>unevalStream · protocol lab</title>
	<meta name="description" content="Inspect devalue's executable head and asynchronous tail protocol live." />
</svelte:head>
{@render children()}
