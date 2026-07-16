import type * as vscode from 'vscode';

export const LASECSIMUL_INTEROP_API_VERSION = 1;
export const LASECSIMUL_EXTENSION_ID = 'josuemoraisgh.lasecsimul';

export interface LasecPlotEndpointDescriptor {
  id: string;
  name: string;
  displayName: string;
  projectId?: string;
  simulationId: string;
  componentId: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  readable: true;
  writable: boolean;
  online: boolean;
  opened: boolean;
  connectedClients: number;
}

export interface LasecPlotDataPacket {
  endpointId: string;
  sequence: number;
  simulationTimeNs: number;
  direction: 'mcu-to-client' | 'client-to-mcu';
  encoding: 'binary';
  data: Uint8Array;
}

export interface LasecPlotCloseEvent {
  reason: string;
}

export interface LasecPlotConnection extends vscode.Disposable {
  readonly endpoint: LasecPlotEndpointDescriptor;
  readonly writable: boolean;
  readonly onData: vscode.Event<Uint8Array>;
  readonly onPacket: vscode.Event<LasecPlotDataPacket>;
  readonly onDidClose: vscode.Event<LasecPlotCloseEvent>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface LasecSimulInteropApi {
  readonly apiVersion: number;
  listLasecPlotEndpoints(): Promise<LasecPlotEndpointDescriptor[]>;
  readonly onDidChangeLasecPlotEndpoints: vscode.Event<void>;
  openLasecPlotEndpoint(
    endpointId: string,
    options?: { writable?: boolean },
  ): Promise<LasecPlotConnection>;
}

export interface LasecSimulExtension {
  readonly isActive: boolean;
  readonly exports: LasecSimulInteropApi | undefined;
  activate(): Promise<LasecSimulInteropApi>;
}
