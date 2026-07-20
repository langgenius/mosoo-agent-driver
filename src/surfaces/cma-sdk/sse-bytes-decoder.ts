import type { CmaSessionEventRecord } from "../../stores/cma-store";
import { CMA_MAX_EVENT_BYTES } from "../../stores/cma-store";
import { CmaSdkError } from "./types";

function parseSseRecord(frame: string): CmaSessionEventRecord | null {
  const dataLines: string[] = [];

  for (const line of frame.split(/\r\n|\r|\n/u)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join("\n")) as CmaSessionEventRecord;
}

function findSseSeparator(
  value: Uint8Array,
  length: number,
  start: number,
  atEof = false,
): { readonly index: number; readonly length: number } | null {
  const lineBreakLength = (index: number): number => {
    if (index >= length) {
      return 0;
    }

    if (value[index] === 13) {
      if (index + 1 >= length) {
        return atEof ? 1 : 0;
      }

      return value[index + 1] === 10 ? 2 : 1;
    }

    return value[index] === 10 ? 1 : 0;
  };

  for (let index = start; index < length;) {
    const first = lineBreakLength(index);

    if (first === 0) {
      index += 1;
      continue;
    }

    const second = lineBreakLength(index + first);

    if (second > 0) {
      return { index, length: first + second };
    }

    index += first;
  }

  return null;
}

function sseFrameLimitError(): CmaSdkError {
  return new CmaSdkError(
    500,
    "CMA_SDK_FRAME_TOO_LARGE",
    `CMA SSE frame exceeds ${CMA_MAX_EVENT_BYTES} UTF-8 bytes.`,
    null,
  );
}

export async function* decodeCmaSseBytes(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<CmaSessionEventRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frame = new Uint8Array(CMA_MAX_EVENT_BYTES + 1);
  let completed = false;
  let frameLength = 0;
  let scanFrom = 0;

  const consume = (separator: {
    readonly index: number;
    readonly length: number;
  }): CmaSessionEventRecord | null => {
    const consumed = separator.index + separator.length;

    if (consumed > CMA_MAX_EVENT_BYTES) {
      throw sseFrameLimitError();
    }

    const record = parseSseRecord(decoder.decode(frame.subarray(0, separator.index)));
    frame.copyWithin(0, consumed, frameLength);
    frameLength -= consumed;
    scanFrom = 0;
    return record;
  };

  const append = (bytes: Uint8Array): CmaSessionEventRecord[] => {
    const records: CmaSessionEventRecord[] = [];

    for (const byte of bytes) {
      if (frameLength >= frame.length) {
        throw sseFrameLimitError();
      }

      frame[frameLength] = byte;
      frameLength += 1;
      const separator = findSseSeparator(frame, frameLength, scanFrom);

      if (!separator) {
        scanFrom = Math.max(0, frameLength - 3);

        if (frameLength > CMA_MAX_EVENT_BYTES) {
          throw sseFrameLimitError();
        }

        continue;
      }

      const record = consume(separator);

      if (record) {
        records.push(record);
      }
    }

    return records;
  };

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        completed = true;
        break;
      }

      for (const record of append(chunk.value)) {
        yield record;
      }
    }

    for (
      let separator = findSseSeparator(frame, frameLength, 0, true);
      separator;
      separator = findSseSeparator(frame, frameLength, 0, true)
    ) {
      const record = consume(separator);

      if (record) {
        yield record;
      }
    }

    if (frameLength > 0) {
      const record = parseSseRecord(decoder.decode(frame.subarray(0, frameLength)));

      if (record) {
        yield record;
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel();
    }
  }
}
