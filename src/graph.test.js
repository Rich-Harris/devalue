import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { create_captured_graph, discover, rollback } from './graph.js';

const test = suite('shared graph');
const create_test_graph = (root) => create_captured_graph(root, () => false);

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

test('applies classifications while graph owns recursive discovery', () => {
	class Box {
		constructor(value) {
			this.value = value;
		}
	}
	const child = {};
	const root = new Box(child);
	const graph = create_captured_graph(root, (value, _node, graph) => {
		if (!(value instanceof Box)) return false;
		const captured = discover(graph, value.value);
		return {
			kind: 'Box',
			data: { child: captured },
			edges: captured ? [{ node: captured.id }] : [{ value: value.value }]
		};
	});
	const node = discover(graph, root);

	assert.is(node?.kind, 'Box');
	assert.is(node?.data.child, graph.identities.get(child));
	assert.equal(node?.edges, [{ node: 1 }]);
});

test('rolls back appended identities without touching earlier captures', () => {
	const shared = {};
	const graph = create_test_graph(shared);
	discover(graph, shared);
	const value = { shared, extra: {} };
	const mark = graph.nodes.length;
	discover(graph, value);
	assert.is(graph.nodes.length, 3);
	rollback(graph, mark);
	assert.is(graph.nodes.length, 1);
	assert.is(graph.identities.size, 1);
	assert.is(graph.identities.has(value), false);
	assert.is(graph.identities.get(shared), graph.nodes[0]);
});

test('rolls back an entire failed recursive discovery', () => {
	const root = { child: {}, invalid: () => {} };
	const graph = create_test_graph(root);
	assert.throws(() => discover(graph, root));
	rollback(graph, 0);

	assert.is(graph.nodes.length, 0);
	assert.is(graph.keys.length, 0);
	assert.is(graph.identities.size, 0);
});

test.run();
