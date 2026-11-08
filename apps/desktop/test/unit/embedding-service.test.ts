import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { serveService, type ServiceCalls, type ServiceStatus } from '@penmoss/embed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingService,
  parseSearchOptions,
  parseServiceNotes,
  type DesktopMeaningStatus,
  type ServiceProcess,
} from '../../src/embedding-service';

const READY: ServiceStatus = {
  state: 'ready',
  enabled: true,
  model: 'fake',
  modelBytes: 1,
  totalBytes: 1,
  license: { name: 'none', url: '' },
  indexed: 1,
  total: 1,
};

/** A utility process stand-in: a real message port to a service, and an exit to crash with. */
class FakeProcess extends EventEmitter implements ServiceProcess {
  readonly pid: number;
  private readonly near: MessagePort;
  readonly far: MessagePort;
  killed = false;
  constructor(pid: number, calls: ServiceCalls) {
    super();
    this.pid = pid;
    const { port1, port2 } = new MessageChannel();
    this.near = port1;
    this.far = port2;
    port1.on('message', (message) => this.emit('message', message));
    serveService(port2, calls);
  }
  postMessage(message: unknown): void {
    this.near.postMessage(message);
  }
  sendStatus(status: ServiceStatus): void {
    this.far.postMessage({ status });
  }
  crash(code: number): void {
    this.near.close();
    this.emit('exit', code);
  }
  kill(): boolean {
    this.killed = true;
    this.crash(0);
    return true;
  }
}

function calls(overrides: Partial<ServiceCalls> = {}): ServiceCalls {
  return {
    status: () => Promise.resolve(READY),
    update: (_notebook, notes) => Promise.resolve(notes.map((note) => note.id)),
    close: () => Promise.resolve(),
    search: () =>
      Promise.resolve({
        floor: 0.28,
        hits: [{ id: 'ups', score: 0.6, heading: null, preview: '' }],
      }),
    setEnabled: (enabled) =>
      Promise.resolve({ ...READY, enabled, state: enabled ? 'ready' : 'off' }),
    ...overrides,
  };
}

let service: EmbeddingService | null = null;
afterEach(() => {
  service?.stop();
  service = null;
  vi.useRealTimers();
});

function setUp(make: () => ServiceCalls = () => calls(), start = true) {
  const processes: FakeProcess[] = [];
  const statuses: DesktopMeaningStatus[] = [];
  const written: boolean[] = [];
  service = new EmbeddingService({
    writeSetting: (enabled) => {
      written.push(enabled);
      return Promise.resolve();
    },
    fork: () => {
      const child = new FakeProcess(100 + processes.length, make());
      processes.push(child);
      return child;
    },
    onStatus: (status) => statuses.push(status),
    log: () => undefined,
    restartDelaysMs: [10, 50],
  });
  if (start) service.start();
  return { service, processes, statuses, written };
}

describe('the embedding service in main (T76)', () => {
  it('relays the page’s calls and passes on the service’s status with its generation', async () => {
    const { service, processes, statuses } = setUp();
    expect(await service.update('nb', [{ id: 'ups', version: 1 }])).toEqual(['ups']);
    expect(await service.search('nb', 'blackout', {})).toMatchObject({ floor: 0.28 });
    processes[0]!.sendStatus(READY);
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({ state: 'ready', generation: 1 }),
    );
    expect(service.status()).toMatchObject({ state: 'ready' });
    expect(await service.setEnabled(false)).toMatchObject({ state: 'off', enabled: false });
    expect(service.pid()).toBe(100);
  });

  it('starts the service again after a crash, the page searching by words meanwhile', async () => {
    const { service, processes, statuses } = setUp();
    processes[0]!.crash(9);
    expect(statuses.at(-1)).toMatchObject({ state: 'restarting', generation: 1 });
    expect(await service.search('nb', 'blackout', {})).toBeNull();
    expect(await service.update('nb', [{ id: 'ups', version: 1 }])).toEqual([]);
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes[1]!.sendStatus(READY);
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({ state: 'ready', generation: 2 }),
    );
    expect(await service.search('nb', 'blackout', {})).not.toBeNull();
  });

  it('switches off while no service runs, and the next one is told as it starts (A1158)', async () => {
    const asked: boolean[] = [];
    const make = () =>
      calls({
        setEnabled: (enabled) => {
          asked.push(enabled);
          return Promise.resolve({ ...READY, enabled, state: enabled ? 'ready' : 'off' });
        },
      });
    // Before the service starts (its first 2 s).
    const { service, processes, written } = setUp(make, false);
    expect(await service.setEnabled(false)).toMatchObject({ state: 'off', enabled: false });
    expect(written).toEqual([false]);
    service.start();
    await vi.waitFor(() => expect(asked).toEqual([false]));
    // While it waits to restart after a crash: it starts again at once, and is told.
    processes[0]!.crash(9);
    expect(await service.setEnabled(true)).toMatchObject({ enabled: true });
    expect(written).toEqual([false, true]);
    expect(processes).toHaveLength(2);
    await vi.waitFor(() => expect(asked).toEqual([false, true]));
  });

  it('fails a call that was waiting when the process went, and backs off', async () => {
    let answer: (() => void) | null = null;
    const { service, processes } = setUp(() =>
      calls({
        search: () =>
          new Promise((resolve) => {
            answer = () => resolve(null);
          }),
      }),
    );
    const waiting = service.search('nb', 'blackout', {});
    await vi.waitFor(() => expect(answer).not.toBeNull());
    processes[0]!.crash(1);
    expect(await waiting).toBeNull();
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes[1]!.crash(1);
    const crashedAt = Date.now();
    await vi.waitFor(() => expect(processes).toHaveLength(3), { timeout: 2_000 });
    expect(Date.now() - crashedAt).toBeGreaterThanOrEqual(40);
  });

  it('stops for good when the app quits', async () => {
    const { service, processes, statuses } = setUp();
    service.stop();
    expect(processes[0]!.killed).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(processes).toHaveLength(1);
  });
});

describe('the page’s input (T76)', () => {
  it('takes notes and search options, and refuses anything else', () => {
    const note = {
      id: 'a',
      version: 2,
      title: 'T',
      sections: [{ heading: null, path: [], text: 'x' }],
    };
    expect(parseServiceNotes([{ id: 'a', version: 'r1' }, note])).toEqual([
      { id: 'a', version: 'r1' },
      note,
    ]);
    expect(parseServiceNotes('nope')).toBeNull();
    expect(parseServiceNotes([{ id: 1, version: 1 }])).toBeNull();
    expect(
      parseServiceNotes([{ ...note, sections: [{ heading: 3, path: [], text: '' }] }]),
    ).toBeNull();
    expect(parseServiceNotes([{ ...note, title: undefined }])).toBeNull();
    expect(parseSearchOptions(undefined)).toEqual({});
    expect(parseSearchOptions({ limit: 5, ids: ['a'] })).toEqual({ limit: 5, ids: ['a'] });
    expect(parseSearchOptions({ limit: -1 })).toBeNull();
    expect(parseSearchOptions({ ids: [1] })).toBeNull();
  });
});
