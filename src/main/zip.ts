import { createReadStream, createWriteStream } from "fs";
import * as zlib from "zlib";
import { Transform } from "stream";

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
export const ZIP_ENTRY_LIMIT = 0xffffffff;

const crcTable = (() => {
  const table = new Int32Array(256);

  for (let i = 0; i < 256; i++) {
    let c = i;

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[i] = c;
  }

  return table;
})();

export function crc32(buffer: Buffer, seed = 0): number {
  let crc = (seed ^ -1) >>> 0;

  for (let i = 0; i < buffer.length; i++) {
    crc = ((crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff]) >>> 0;
  }

  return (crc ^ -1) >>> 0;
}

export class ZipLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitExceededError";
  }
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);

  return { time, date: day };
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private readonly out: NodeJS.WritableStream;
  private readonly entries: CentralEntry[] = [];
  private offset = 0;
  private closed = false;

  constructor(private readonly destination: string) {
    this.out = createWriteStream(destination);
  }

  private write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;

    return new Promise((resolve, reject) => {
      this.out.write(chunk, error => (error ? reject(error) : resolve()));
    });
  }

  async addFile(entryName: string, sourcePath: string, mtime = new Date()): Promise<void> {
    if (this.closed) throw new Error("archive already finalized");

    const name = Buffer.from(entryName.replace(/\\/g, "/"), "utf8");
    const { time, date } = dosDateTime(mtime);
    const localOffset = this.offset;
    const header = Buffer.alloc(30 + name.length);

    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4); 
    header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); 
    header.writeUInt32LE(0, 18); 
    header.writeUInt32LE(0, 22); 
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, 30);

    await this.write(header);

    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;

    const source = createReadStream(sourcePath);
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        crc = crc32(chunk, crc);
        uncompressedSize += chunk.length;
        callback(null, chunk);
      },
    });
    const deflate = zlib.createDeflateRaw({ level: 6 });

    source.on("error", error => deflate.destroy(error));
    counter.on("error", error => deflate.destroy(error));
    source.pipe(counter).pipe(deflate);

    for await (const chunk of deflate as AsyncIterable<Buffer>) {
      compressedSize += chunk.length;
      await this.write(chunk);
    }

    if (uncompressedSize > ZIP_ENTRY_LIMIT || this.offset > ZIP_ENTRY_LIMIT) {
      throw new ZipLimitExceededError(
        "the archive would exceed 4 GiB, which needs ZIP64 - collect into a folder instead",
      );
    }

    const descriptor = Buffer.alloc(16);

    descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);

    await this.write(descriptor);

    this.entries.push({
      name,
      crc,
      compressedSize,
      uncompressedSize,
      offset: localOffset,
      time,
      date,
    });
  }

  async finalize(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const centralStart = this.offset;

    for (const entry of this.entries) {
      const record = Buffer.alloc(46 + entry.name.length);

      record.writeUInt32LE(CENTRAL_HEADER, 0);
      record.writeUInt16LE(0x0314, 4); 
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8);
      record.writeUInt16LE(METHOD_DEFLATE, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.uncompressedSize, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt16LE(0, 30); 
      record.writeUInt16LE(0, 32); 
      record.writeUInt16LE(0, 34); 
      record.writeUInt16LE(0, 36); 
      record.writeUInt32LE((0o100644 << 16) >>> 0, 38); 
      record.writeUInt32LE(entry.offset, 42);
      entry.name.copy(record, 46);

      await this.write(record);
    }

    const centralSize = this.offset - centralStart;
    const end = Buffer.alloc(22);

    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);

    await this.write(end);

    await new Promise<void>((resolve, reject) => {
      this.out.end(() => resolve());
      this.out.on("error", reject);
    });
  }

  get path(): string {
    return this.destination;
  }
}
