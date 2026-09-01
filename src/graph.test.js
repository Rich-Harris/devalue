import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { begin_region, create_graph, discover, rollback_region } from './graph.js';

const test = suite('shared graph');
const create_test_graph = (root) => create_graph(root, () => false);

test('records one node per identity', () => {
	const shared = {};
	const root = { first: shared, second: shared };
	root.self = root;
	const graph = create_test_graph(root);
	discover(graph, root);

	assert.is(graph.nodes.length, 2);
	assert.is(graph.identities.get(root), graph.nodes[0]);
	assert.is(graph.identities.get(shared), graph.nodes[1]);
});

test('captures sparse arrays and container order as canonical edges', () => {
	const key = {};
	const array = Array(5);
	array[3] = key;
	const map = new Map([[key, array]]);
	const set = new Set([array, key]);
	const root = { map, set };
	const graph = create_test_graph(root);
	discover(graph, root);

	const array_node = graph.identities.get(array);
	assert.equal(array_node?.data.entries.map((entry) => entry[0]), ['3']);
	assert.is(array_node?.data.length, 5);
	assert.equal(graph.identities.get(map)?.data.entries[0][0], { node: graph.identities.get(key)?.id });
	assert.equal(graph.identities.get(set)?.data.values.map((edge) => edge.node), [array_node?.id, graph.identities.get(key)?.id]);
});

test('rolls back appended identities without touching earlier regions', () => {
	const shared = {};
	const graph = create_test_graph(shared);
	discover(graph, shared);
	const region = begin_region(graph);
	const value = { shared, extra: {} };
	discover(graph, value);
	assert.is(graph.nodes.length, 3);

	rollback_region(graph, region);
	assert.is(graph.nodes.length, 1);
	assert.is(graph.identities.size, 1);
	assert.is(graph.identities.has(value), false);
	assert.is(graph.identities.get(shared), graph.nodes[0]);
});

test('rolls back an entire failed recursive discovery', () => {
	const root = { child: {}, invalid: () => {} };
	const graph = create_test_graph(root);
	const region = begin_region(graph);

	assert.throws(() => discover(graph, root));
	rollback_region(graph, region);

	assert.is(graph.nodes.length, 0);
	assert.is(graph.identities.size, 0);
});

test.run();
