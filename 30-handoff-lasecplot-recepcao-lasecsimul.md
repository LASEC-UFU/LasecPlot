# Handoff para o agente do LasecPlot — receber dados do dispositivo LasecPlot do LasecSimul

## Objetivo

Implementar, **no projeto/extensão LasecPlot**, um consumidor da API pública exportada pela extensão VS Code LasecSimul. O resultado deve descobrir fontes `LasecPlot` abertas no schematic, permitir que o usuário escolha uma delas, abrir uma conexão de leitura e entregar os bytes recebidos ao parser/pipeline visual já existente do LasecPlot.

Este trabalho é do lado consumidor. Não altere o LasecSimul e não crie uma segunda ponte por COM, arquivo, TCP, UDP ou polling de propriedades internas.

## Provedor existente

- ID oficial da extensão: `josuemoraisgh.lasecsimul`.
- A função `activate()` da extensão retorna `LasecSimulInteropApi`.
- Versão atual do contrato: `apiVersion === 1`.
- O transporte entre extensões entrega bytes binários como `Uint8Array`.
- O endpoint somente aparece em `listLasecPlotEndpoints()` quando:
  1. existe um componente `peripherals.lasecplot` no schematic;
  2. a simulação está iniciada;
  3. o usuário abriu/publicou o componente LasecPlot.

O contrato canônico do provedor está em `extension/src/lasecplot/api.ts` no repositório LasecSimul.

## Contrato TypeScript a manter no consumidor

Copie estas interfaces para um módulo de tipos local do LasecPlot ou mova-as para um pacote compartilhado. Não importe um arquivo TypeScript interno da instalação do LasecSimul em runtime.

```ts
import type * as vscode from "vscode";

export const LASECSIMUL_INTEROP_API_VERSION = 1;

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
  parity: "none" | "even" | "odd";
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
  direction: "mcu-to-client" | "client-to-mcu";
  encoding: "binary";
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
```

## Requisitos funcionais

### 1. Descoberta do LasecSimul

Use exclusivamente a API de extensões do VS Code:

```ts
const extension = vscode.extensions.getExtension<LasecSimulInteropApi>(
  "josuemoraisgh.lasecsimul",
);
```

Trate a ausência da extensão como uma fonte opcional indisponível, sem derrubar a ativação do LasecPlot. Se a extensão existir mas ainda não estiver ativa, chame `await extension.activate()`. Rejeite versões diferentes de `1` com uma mensagem clara de incompatibilidade.

### 2. Lista de fontes

- Faça uma leitura inicial com `listLasecPlotEndpoints()`.
- Assine `onDidChangeLasecPlotEndpoints` e atualize a lista sempre que o evento ocorrer.
- Identifique uma fonte pelo campo `id`, nunca apenas por `name` ou `displayName`.
- Mostre `displayName` ao usuário.
- Nomes podem se repetir; o provedor desambigua `displayName` com `componentId` quando necessário.
- Um endpoint removido da nova lista deve desaparecer da UI.
- Não presuma que o primeiro endpoint seja sempre a fonte correta: apresente seleção quando houver mais de um.

### 3. Abertura para recepção

Para somente receber dados gerados pelo dispositivo, abra como leitor:

```ts
const connection = await api.openLasecPlotEndpoint(endpoint.id, {
  writable: false,
});
```

Vários leitores são permitidos. Apenas um cliente escritor é permitido, mas escrita não faz parte deste escopo inicial.

Registre os listeners imediatamente e mantenha todos os `Disposable` associados à sessão/conexão atual. Ao trocar de fonte, fechar a tela ou desativar o LasecPlot, descarte listeners e chame `await connection.close()` ou `connection.dispose()`.

### 4. Recepção dos dados

Há duas alternativas para observar o fluxo:

- `connection.onData(bytes)`: entrega somente bytes MCU/dispositivo → LasecPlot;
- `connection.onPacket(packet)`: entrega bytes e metadados de direção, sequência e tempo simulado.

**Não alimente o mesmo parser com `onData` e `onPacket` simultaneamente**, pois o fluxo MCU→cliente seria processado duas vezes.

Recomendação: use `onPacket` e filtre explicitamente:

```ts
const packetSubscription = connection.onPacket((packet) => {
  if (packet.direction !== "mcu-to-client") return;

  // O parser deve aceitar fragmentos arbitrários.
  existingIncrementalParser.push(packet.data);

  // Útil para diagnóstico, ordenação e eixo temporal opcional.
  telemetry.notePacket({
    endpointId: packet.endpointId,
    sequence: packet.sequence,
    simulationTimeNs: packet.simulationTimeNs,
  });
});
```

Os limites de cada `Uint8Array` **não têm significado de protocolo**. Um lote pode conter:

- parte de uma linha;
- várias linhas;
- uma amostra binária incompleta;
- várias amostras completas;
- bytes `0x00`, `0x80`, `0xFF` e qualquer outro valor.

Não use `TextDecoder.decode(chunk)` isoladamente para cada lote se o protocolo puder conter UTF-8 fragmentado. Use decoder streaming ou, preferencialmente, alimente os bytes no parser incremental já existente.

Exemplo para protocolo textual por linhas:

```ts
const decoder = new TextDecoder();
let pendingText = "";

function acceptBytes(bytes: Uint8Array): void {
  pendingText += decoder.decode(bytes, { stream: true });
  const lines = pendingText.split(/\r?\n/);
  pendingText = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length > 0) parseCompleteLine(line);
  }
}
```

Não converta os dados para hexadecimal. Hexadecimal existe somente no IPC interno Core↔LasecSimul; a API pública já entrega os bytes originais.

### 5. Sequência e tempo

- `sequence` é monotônico enquanto o endpoint permanece publicado e reinicia quando ele é aberto novamente.
- `simulationTimeNs` é tempo da simulação, não relógio de parede.
- Não use a chegada no Extension Host como timestamp da amostra quando `simulationTimeNs` estiver disponível.
- Uma quebra de sequência deve gerar diagnóstico, não necessariamente encerrar a conexão.
- Se futuramente houver escrita bidirecional, pacotes `client-to-mcu` também consomem números da mesma sequência. Por isso a validação deve considerar todos os pacotes observados antes de filtrar a direção, ou tratar saltos apenas como aviso.

### 6. Fechamento e reconexão

Assine `onDidClose`:

```ts
const closeSubscription = connection.onDidClose(({ reason }) => {
  currentConnection = undefined;
  sourceState.setDisconnected(reason);
});
```

Motivos atuais incluem:

- `device-closed`: usuário fechou o endpoint;
- `simulation-stopped`: simulação foi parada;
- `device-removed`: componente removido;
- `transport-error`: falha no transporte UART/Core;
- `extension-deactivated`: LasecSimul foi desativado;
- `client-closed` ou `disposed`: fechamento iniciado pelo consumidor.

Após fechamento externo, atualize a UI e aguarde novo evento de endpoints. Reconexão automática só deve ocorrer se essa for uma opção explícita do produto. O `id` contém uma sessão aleatória e muda quando o LasecSimul/Core inicia uma nova sessão; se houver reconexão, procure uma fonte compatível por `projectId + componentId`, peça confirmação ao usuário em caso de ambiguidade e use o novo `id`.

## Implementação de referência

```ts
import * as vscode from "vscode";
import type {
  LasecPlotConnection,
  LasecPlotDataPacket,
  LasecPlotEndpointDescriptor,
  LasecSimulInteropApi,
} from "./lasecsimulInterop";

export class LasecSimulSourceProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private connectionDisposables: vscode.Disposable[] = [];
  private api?: LasecSimulInteropApi;
  private connection?: LasecPlotConnection;
  private endpoints: LasecPlotEndpointDescriptor[] = [];

  constructor(
    private readonly onEndpointsChanged: (
      endpoints: readonly LasecPlotEndpointDescriptor[],
    ) => void,
    private readonly onPacket: (packet: LasecPlotDataPacket) => void,
    private readonly onDisconnected: (reason: string) => void,
  ) {}

  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<LasecSimulInteropApi>(
      "josuemoraisgh.lasecsimul",
    );
    if (!extension) {
      this.endpoints = [];
      this.onEndpointsChanged(this.endpoints);
      return;
    }

    const api = extension.isActive
      ? extension.exports
      : await extension.activate();

    if (!api || api.apiVersion !== 1) {
      throw new Error(
        `API do LasecSimul incompatível: esperado 1, recebido ${api?.apiVersion ?? "ausente"}`,
      );
    }

    this.api = api;
    this.disposables.push(
      api.onDidChangeLasecPlotEndpoints(() => void this.refreshEndpoints()),
    );
    await this.refreshEndpoints();
  }

  get currentEndpoints(): readonly LasecPlotEndpointDescriptor[] {
    return this.endpoints;
  }

  async connect(endpointId: string): Promise<void> {
    if (!this.api) throw new Error("LasecSimul não está disponível.");
    await this.disconnect();

    const connection = await this.api.openLasecPlotEndpoint(endpointId, {
      writable: false,
    });
    this.connection = connection;
    this.connectionDisposables = [
      connection.onPacket((packet) => {
        if (packet.direction === "mcu-to-client") this.onPacket(packet);
      }),
      connection.onDidClose(({ reason }) => {
        this.disposeConnectionListeners();
        this.connection = undefined;
        this.onDisconnected(reason);
      }),
    ];
  }

  async disconnect(): Promise<void> {
    const current = this.connection;
    this.connection = undefined;
    this.disposeConnectionListeners();
    if (current) await current.close();
  }

  private async refreshEndpoints(): Promise<void> {
    if (!this.api) return;
    try {
      this.endpoints = await this.api.listLasecPlotEndpoints();
      this.onEndpointsChanged(this.endpoints);
    } catch (error) {
      this.endpoints = [];
      this.onEndpointsChanged(this.endpoints);
      console.error("Falha ao listar fontes LasecSimul", error);
    }
  }

  private disposeConnectionListeners(): void {
    for (const disposable of this.connectionDisposables.splice(0)) {
      disposable.dispose();
    }
  }

  dispose(): void {
    const current = this.connection;
    this.connection = undefined;
    this.disposeConnectionListeners();
    current?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
```

Adapte nomes e integração ao padrão arquitetural do repositório LasecPlot. Não crie um segundo gerenciador global se o projeto já possuir um serviço de fontes/conexões.

## UI mínima esperada no LasecPlot

- Estado “LasecSimul não instalado” quando a extensão não existir.
- Estado “Nenhuma fonte aberta” quando a extensão existir mas a lista estiver vazia.
- Seletor usando `displayName` quando houver uma ou mais fontes.
- Ação Conectar/Desconectar.
- Indicação da fonte selecionada e do estado da conexão.
- Mensagem acionável para versão incompatível ou falha ao abrir.
- Motivo do fechamento apresentado de forma amigável.
- A UI não deve bloquear a ativação do restante do LasecPlot quando o LasecSimul estiver ausente.

## Testes obrigatórios no projeto LasecPlot

Crie um mock de `LasecSimulInteropApi` e cubra pelo menos:

1. LasecSimul ausente não causa exceção na ativação.
2. Extensão inativa é ativada antes do uso.
3. `apiVersion !== 1` é rejeitada.
4. Lista inicial de endpoints chega à UI.
5. Evento `onDidChangeLasecPlotEndpoints` atualiza a lista.
6. Seleção usa `id`, inclusive com nomes duplicados.
7. `connect()` chama `openLasecPlotEndpoint(id, { writable: false })`.
8. Dois lotes que formam uma única linha/amostra são remontados pelo parser incremental.
9. Um lote com várias linhas/amostras gera todas as amostras.
10. Bytes binários `00 80 FF 0D 0A` chegam sem alteração.
11. `client-to-mcu` não entra no parser de recepção.
12. O mesmo fluxo não é processado duas vezes por assinatura simultânea de `onData` e `onPacket`.
13. `onDidClose` limpa a conexão e informa o motivo.
14. Trocar de endpoint fecha e descarta a conexão anterior.
15. `dispose()` remove todas as inscrições.

## Teste integrado manual

1. Inicie VS Code com as extensões LasecSimul e LasecPlot instaladas no mesmo Extension Host.
2. No LasecSimul, adicione um MCU/gerador UART e um componente `LasecPlot`.
3. Conecte TX do gerador ao RX do LasecPlot.
4. Configure o mesmo baud rate, data bits, stop bits e paridade usados pelo gerador.
5. Inicie a simulação.
6. Clique em **Abrir** no componente LasecPlot.
7. No LasecPlot consumidor, confirme que a fonte aparece com o `displayName` correto.
8. Conecte como leitor.
9. Gere dados textuais fragmentados e bytes binários; confirme que não há perda, duplicação ou alteração.
10. Pause e retome a simulação: a conexão deve permanecer, sem dados novos durante a pausa.
11. Pare a simulação: o consumidor deve receber `simulation-stopped` e mostrar estado desconectado.
12. Reinicie, reabra o componente e confirme que a nova sessão pode ser descoberta/conectada.

## Critérios de aceite

- O LasecPlot recebe dados reais do dispositivo `peripherals.lasecplot` sem COM virtual ou transporte alternativo.
- Todos os bytes chegam na mesma ordem e sem transformação.
- Fragmentação de lotes não altera o parsing de linhas/amostras.
- Não há duplicação causada pelo uso simultâneo de `onData` e `onPacket`.
- Múltiplas fontes são listadas e selecionadas corretamente.
- Ausência, parada ou desativação do LasecSimul não derruba o LasecPlot.
- Conexões e listeners não vazam ao trocar fonte, fechar painel ou desativar a extensão.
- Testes unitários do consumidor e o teste integrado manual passam.

## Restrições importantes

- Não interpretar fronteira de lote como fronteira de mensagem.
- Não usar nome visível como identidade persistente.
- Não acessar `uart_rx_hex`, `uart_tx_hex` ou outros detalhes do Core diretamente.
- Não adicionar dependência de porta COM virtual.
- Não solicitar `{ writable: true }` para um consumidor somente leitura.
- Não modificar o LasecSimul para acomodar decisões internas do parser do LasecPlot; mantenha o acoplamento somente no contrato versionado acima.

