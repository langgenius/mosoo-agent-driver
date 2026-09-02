const MAX_ACP_MESSAGE_BYTES = 8 * 1_024 * 1_024;

export function limitAcpInput(
  input: ReadableStream<Uint8Array>,
  maxMessageBytes = MAX_ACP_MESSAGE_BYTES,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new RangeError("ACP message byte limit must be a positive safe integer.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pendingBytes = 0;

  const append = (bytes: Uint8Array, lineEnded: boolean): void => {
    if (bytes.byteLength === 0 && !lineEnded) {
      return;
    }

    pendingBytes += bytes.byteLength;
    if (pendingBytes > maxMessageBytes) {
      throw new Error(`ACP message exceeds ${maxMessageBytes} bytes.`);
    }

    decoder.decode(bytes, { stream: !lineEnded });
    if (lineEnded) {
      pendingBytes = 0;
    }
  };

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let lineStart = 0;
        for (
          let newline = chunk.indexOf(0x0a);
          newline >= 0;
          newline = chunk.indexOf(0x0a, lineStart)
        ) {
          append(chunk.subarray(lineStart, newline), true);
          lineStart = newline + 1;
        }

        append(chunk.subarray(lineStart), false);

        controller.enqueue(chunk);
      },
      flush() {
        if (pendingBytes > 0) {
          decoder.decode();
        }
      },
    }),
  );
}
