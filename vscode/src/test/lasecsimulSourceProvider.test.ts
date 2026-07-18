import assert from 'node:assert/strict';
import test from 'node:test';
import type * as vscode from 'vscode';
import { DeviceStreamParser, type ParsedDeviceMessage } from '../deviceStreamParser';
import type {
  LasecPlotCloseEvent,
  LasecPlotConnection,
  LasecPlotDataPacket,
  LasecPlotEndpointDescriptor,
  LasecSimulInteropApi,
} from '../lasecsimulInterop';
import { LasecSimulSourceProvider } from '../lasecsimulSourceProvider';

class MockEvent<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  disposeCount = 0;

  readonly event: vscode.Event<T> = ((listener: (event: T) => unknown) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        if (this.listeners.delete(listener)) this.disposeCount++;
      },
    };
  }) as vscode.Event<T>;

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class MockConnection implements LasecPlotConnection {
  readonly packets = new MockEvent<LasecPlotDataPacket>();
  readonly data = new MockEvent<Uint8Array>();
  readonly closed = new MockEvent<LasecPlotCloseEvent>();
  readonly onPacket = this.packets.event;
  readonly onData = this.data.event;
  readonly onDidClose = this.closed.event;
  closeCount = 0;
  disposeCount = 0;
  writes: Uint8Array[] = [];

  constructor(
    readonly endpoint: LasecPlotEndpointDescriptor,
    readonly writable: boolean,
  ) {}

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(new Uint8Array(data));
  }

  async close(): Promise<void> {
    this.closeCount++;
  }

  dispose(): void {
    this.disposeCount++;
  }
}

class MockApi implements LasecSimulInteropApi {
  apiVersion = 1;
  endpoints: LasecPlotEndpointDescriptor[] = [];
  readonly changed = new MockEvent<void>();
  readonly onDidChangeLasecPlotEndpoints = this.changed.event;
  readonly openCalls: Array<{ id: string; options?: { writable?: boolean } }> = [];
  readonly connections: MockConnection[] = [];

  async listLasecPlotEndpoints(): Promise<LasecPlotEndpointDescriptor[]> {
    return this.endpoints;
  }

  async openLasecPlotEndpoint(id: string, options?: { writable?: boolean }): Promise<LasecPlotConnection> {
    this.openCalls.push({ id, options });
    const endpoint = this.endpoints.find(item => item.id === id);
    if (!endpoint) throw new Error('missing endpoint');
    const connection = new MockConnection(endpoint, options?.writable === true);
    this.connections.push(connection);
    return connection;
  }
}

function endpoint(id: string, displayName = 'Device', writable = true): LasecPlotEndpointDescriptor {
  return {
    id,
    name: 'duplicate-name',
    displayName,
    simulationId: 'simulation',
    componentId: `component-${id}`,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    readable: true,
    writable,
    online: true,
    opened: true,
    connectedClients: 0,
  };
}

function packet(
  endpointId: string,
  sequence: number,
  data: number[],
  direction: LasecPlotDataPacket['direction'] = 'mcu-to-client',
): LasecPlotDataPacket {
  return {
    endpointId,
    sequence,
    simulationTimeNs: 25_000_000,
    direction,
    encoding: 'binary',
    data: Uint8Array.from(data),
  };
}

function providerFor(api: MockApi, active = true) {
  let activateCount = 0;
  const states: unknown[] = [];
  const provider = new LasecSimulSourceProvider(
    () => ({
      isActive: active,
      exports: active ? api : undefined,
      activate: async () => {
        activateCount++;
        return api;
      },
    }),
    state => states.push(state),
  );
  return { provider, states, get activateCount() { return activateCount; } };
}

test('LasecSimul ausente não causa exceção', async () => {
  const states: any[] = [];
  const provider = new LasecSimulSourceProvider(() => undefined, state => states.push(state));
  await provider.initialize();
  assert.equal(states.at(-1).availability, 'not-installed');
  assert.deepEqual(states.at(-1).endpoints, []);
});

test('extensão inativa é ativada antes do uso', async () => {
  const api = new MockApi();
  const fixture = providerFor(api, false);
  await fixture.provider.initialize();
  assert.equal(fixture.activateCount, 1);
});

test('versão incompatível é rejeitada com estado acionável', async () => {
  const api = new MockApi();
  api.apiVersion = 2;
  const fixture = providerFor(api);
  await assert.rejects(() => fixture.provider.initialize(), /esperado 1, recebido 2/);
  assert.equal(fixture.provider.state.availability, 'incompatible');
});

test('lista inicial de endpoints chega ao consumidor', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('one')];
  const fixture = providerFor(api);
  await fixture.provider.initialize();
  assert.equal(fixture.provider.state.endpoints[0].id, 'one');
});

test('evento de endpoints atualiza e remove fontes da lista', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('old')];
  const fixture = providerFor(api);
  await fixture.provider.initialize();
  api.endpoints = [endpoint('new')];
  api.changed.fire();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.provider.state.endpoints.map(item => item.id), ['new']);
});

test('seleção usa id mesmo com nomes duplicados', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('first', 'Same'), endpoint('second', 'Same')];
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'second', () => {}, () => {});
  assert.equal(api.openCalls[0].id, 'second');
});

test('conexão solicita escrita e encaminha bytes ao endpoint', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('rw')];
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'rw', () => {}, () => {});
  assert.deepEqual(api.openCalls[0], { id: 'rw', options: { writable: true } });
  await provider.write('client', Uint8Array.from([0, 128, 255]));
  assert.deepEqual([...api.connections[0].writes[0]], [0, 128, 255]);
});

test('fonte read-only abre como leitora e continua recebendo como serial', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('rx-only', 'RX only', false)];
  const received: number[][] = [];
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'rx-only', value => received.push([...value.data]), () => {});
  assert.deepEqual(api.openCalls[0], { id: 'rx-only', options: { writable: false } });
  api.connections[0].packets.fire(packet('rx-only', 0, [1, 2, 3]));
  assert.deepEqual(received, [[1, 2, 3]]);
  await assert.rejects(() => provider.write('client', Uint8Array.of(4)), /somente para leitura/);
});

test('parser incremental remonta uma linha dividida em dois lotes', () => {
  const messages: ParsedDeviceMessage[] = [];
  const parser = new DeviceStreamParser(message => messages.push(message));
  parser.push(Buffer.from('>temp:12'), 1);
  parser.push(Buffer.from('3\r\n'), 2);
  assert.deepEqual(messages, [{ data: '>temp:123', isRaw: false, timestamp: 2 }]);
});

test('parser incremental emite todas as linhas de um único lote', () => {
  const messages: ParsedDeviceMessage[] = [];
  const parser = new DeviceStreamParser(message => messages.push(message));
  parser.push(Buffer.from('one\ntwo\nthree\n'), 4);
  assert.deepEqual(messages.map(message => message.data), ['one', 'two', 'three']);
});

test('bytes binários chegam ao consumidor sem alteração', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('binary')];
  const received: number[][] = [];
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'binary', value => received.push([...value.data]), () => {});
  api.connections[0].packets.fire(packet('binary', 0, [0x00, 0x80, 0xff, 0x0d, 0x0a]));
  assert.deepEqual(received, [[0x00, 0x80, 0xff, 0x0d, 0x0a]]);
});

test('pacote client-to-mcu não entra no parser de recepção', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('filter')];
  let received = 0;
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'filter', () => received++, () => {});
  api.connections[0].packets.fire(packet('filter', 0, [1], 'client-to-mcu'));
  assert.equal(received, 0);
});

test('fluxo é assinado apenas em onPacket, sem duplicação por onData', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('single-subscription')];
  let received = 0;
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'single-subscription', () => received++, () => {});
  const connection = api.connections[0];
  assert.equal(connection.packets.listenerCount, 1);
  assert.equal(connection.data.listenerCount, 0);
  connection.packets.fire(packet('single-subscription', 0, [1]));
  connection.data.fire(Uint8Array.from([1]));
  assert.equal(received, 1);
});

test('onDidClose limpa a conexão e informa o motivo', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('close')];
  let reason = '';
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'close', () => {}, value => { reason = value; });
  api.connections[0].closed.fire({ reason: 'simulation-stopped' });
  assert.equal(reason, 'simulation-stopped');
  assert.equal(provider.hasConnection('client'), false);
  await assert.rejects(() => provider.write('client', Uint8Array.of(1)), /Não há/);
});

test('trocar de endpoint fecha e descarta listeners da conexão anterior', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('a'), endpoint('b')];
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'a', () => {}, () => {});
  const first = api.connections[0];
  await provider.connect('client', 'b', () => {}, () => {});
  assert.equal(first.closeCount, 1);
  assert.equal(first.packets.listenerCount, 0);
  assert.equal(api.openCalls[1].id, 'b');
});

test('dispose remove todas as inscrições e descarta conexões', async () => {
  const api = new MockApi();
  api.endpoints = [endpoint('dispose')];
  const { provider } = providerFor(api);
  await provider.initialize();
  await provider.connect('client', 'dispose', () => {}, () => {});
  const connection = api.connections[0];
  provider.dispose();
  assert.equal(api.changed.listenerCount, 0);
  assert.equal(connection.packets.listenerCount, 0);
  assert.equal(connection.closed.listenerCount, 0);
  assert.equal(connection.disposeCount, 1);
});
