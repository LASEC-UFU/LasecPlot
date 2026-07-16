export interface ParsedDeviceMessage {
  data: string | Uint8Array;
  isRaw: boolean;
  timestamp: number;
}

/** Incrementally reconstructs LasecPlot text lines and binary plotRaw frames. */
export class DeviceStreamParser {
  private buffer = Buffer.alloc(0);
  private readonly rawEnd = Buffer.from('|g\r\n');

  constructor(private readonly accept: (message: ParsedDeviceMessage) => void) {}

  push(bytes: Uint8Array, timestamp: number): void {
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ]);

    while (this.buffer.length > 0) {
      if (this.buffer[0] === 0x3c) { // '<'
        const endIndex = this.buffer.indexOf(this.rawEnd);
        if (endIndex === -1) return;

        const frameLength = endIndex + this.rawEnd.length;
        const frame = this.buffer.subarray(0, frameLength);
        this.buffer = this.buffer.subarray(frameLength);
        this.accept({ data: new Uint8Array(frame), isRaw: true, timestamp });
        continue;
      }

      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex === -1) return;

      let line = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      this.accept({ data: line.toString('utf8'), isRaw: false, timestamp });
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
