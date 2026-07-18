import type * as vscode from 'vscode';
import {
  LASECSIMUL_EXTENSION_ID,
  LASECSIMUL_INTEROP_API_VERSION,
  type LasecPlotConnection,
  type LasecPlotDataPacket,
  type LasecPlotEndpointDescriptor,
  type LasecSimulExtension,
  type LasecSimulInteropApi,
} from './lasecsimulInterop';

export type LasecSimulAvailability =
  | 'not-installed'
  | 'ready'
  | 'incompatible'
  | 'error';

export interface LasecSimulSourceState {
  availability: LasecSimulAvailability;
  endpoints: readonly LasecPlotEndpointDescriptor[];
  message?: string;
}

interface ConnectionSession {
  connection: LasecPlotConnection;
  subscriptions: vscode.Disposable[];
  lastSequence?: number;
}

export class LasecSimulSourceProvider implements vscode.Disposable {
  private api?: LasecSimulInteropApi;
  private endpoints: LasecPlotEndpointDescriptor[] = [];
  private availability: LasecSimulAvailability = 'not-installed';
  private message?: string;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly sessions = new Map<string, ConnectionSession>();
  private disposed = false;

  constructor(
    private readonly getExtension: (id: string) => LasecSimulExtension | undefined,
    private readonly onStateChanged: (state: LasecSimulSourceState) => void,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  get state(): LasecSimulSourceState {
    return {
      availability: this.availability,
      endpoints: this.endpoints,
      message: this.message,
    };
  }

  async initialize(): Promise<void> {
    const extension = this.getExtension(LASECSIMUL_EXTENSION_ID);
    if (!extension) {
      this.setState('not-installed', [], 'LasecSimul não instalado');
      return;
    }

    const api = extension.isActive ? extension.exports : await extension.activate();
    if (!api || api.apiVersion !== LASECSIMUL_INTEROP_API_VERSION) {
      const received = api?.apiVersion ?? 'ausente';
      const message = `API do LasecSimul incompatível: esperado 1, recebido ${received}`;
      this.setState('incompatible', [], message);
      throw new Error(message);
    }

    if (this.disposed) return;
    this.api = api;
    this.subscriptions.push(
      api.onDidChangeLasecPlotEndpoints(() => void this.refreshEndpoints()),
    );
    await this.refreshEndpoints();
  }

  async refreshEndpoints(): Promise<void> {
    if (!this.api || this.disposed) return;
    try {
      const endpoints = await this.api.listLasecPlotEndpoints();
      if (!this.disposed) this.setState('ready', endpoints);
    } catch (error) {
      const message = `Falha ao listar fontes LasecSimul: ${errorMessage(error)}`;
      this.setState('error', [], message);
      this.warn(message);
    }
  }

  async connect(
    clientId: string,
    endpointId: string,
    onPacket: (packet: LasecPlotDataPacket) => void,
    onDisconnected: (reason: string) => void,
  ): Promise<LasecPlotEndpointDescriptor> {
    if (!this.api) throw new Error(this.message ?? 'LasecSimul não está disponível.');
    const endpoint = this.endpoints.find(candidate => candidate.id === endpointId);
    if (!endpoint) throw new Error('A fonte selecionada não está mais disponível. Atualize a lista.');

    await this.disconnect(clientId);
    const connection = await this.api.openLasecPlotEndpoint(endpoint.id, {
      writable: endpoint.writable,
    });
    if (this.disposed) {
      connection.dispose();
      throw new Error('LasecPlot foi desativado durante a conexão.');
    }

    const session: ConnectionSession = { connection, subscriptions: [] };
    this.sessions.set(clientId, session);
    session.subscriptions.push(
      connection.onPacket(packet => {
        const previous = session.lastSequence;
        if (previous !== undefined && packet.sequence !== previous + 1) {
          this.warn(
            `[LasecSimul] quebra de sequência em ${packet.endpointId}: ` +
            `esperado ${previous + 1}, recebido ${packet.sequence}`,
          );
        }
        session.lastSequence = packet.sequence;
        if (packet.direction === 'mcu-to-client') onPacket(packet);
      }),
      connection.onDidClose(({ reason }) => {
        if (this.sessions.get(clientId) !== session) return;
        this.sessions.delete(clientId);
        this.disposeSubscriptions(session);
        onDisconnected(reason);
      }),
    );
    return connection.endpoint;
  }

  hasConnection(clientId: string): boolean {
    return this.sessions.has(clientId);
  }

  async write(clientId: string, data: Uint8Array): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session) throw new Error('Não há uma fonte LasecSimul conectada.');
    if (!session.connection.writable) throw new Error('A fonte LasecSimul está aberta somente para leitura.');
    await session.connection.write(data);
  }

  async disconnect(clientId: string): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session) return;
    this.sessions.delete(clientId);
    this.disposeSubscriptions(session);
    await session.connection.close();
  }

  private setState(
    availability: LasecSimulAvailability,
    endpoints: LasecPlotEndpointDescriptor[],
    message?: string,
  ): void {
    this.availability = availability;
    this.endpoints = endpoints;
    this.message = message;
    this.onStateChanged(this.state);
  }

  private disposeSubscriptions(session: ConnectionSession): void {
    for (const subscription of session.subscriptions.splice(0)) subscription.dispose();
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      this.disposeSubscriptions(session);
      session.connection.dispose();
    }
    this.sessions.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
