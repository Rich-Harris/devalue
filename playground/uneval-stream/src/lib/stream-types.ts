export type RunStatus = 'idle' | 'compiling' | 'streaming' | 'complete' | 'error' | 'stopped';

export type SnapshotNode = {
	kind: string;
	id?: number;
	ref?: number;
	label?: string;
	value?: string;
	meta?: string;
	state?: 'pending' | 'fulfilled' | 'rejected' | 'streaming' | 'complete' | 'error';
	children?: SnapshotEntry[];
};

export type SnapshotEntry = { key: string; value: SnapshotNode };

export type WorkerMessage =
	| { type: 'status'; runId: number; status: RunStatus; elapsed: number }
	| { type: 'block'; runId: number; kind: 'head' | 'tail'; index: number; source: string; bytes: number; elapsed: number }
	| { type: 'snapshot'; runId: number; snapshot: SnapshotNode; elapsed: number }
	| { type: 'error'; runId: number; message: string; stack?: string; elapsed: number }
	| { type: 'done'; runId: number; elapsed: number };

export type WorkerPayload =
	| { type: 'status'; status: RunStatus }
	| { type: 'block'; kind: 'head' | 'tail'; index: number; source: string; bytes: number }
	| { type: 'snapshot'; snapshot: SnapshotNode }
	| { type: 'error'; message: string; stack?: string }
	| { type: 'done' };
