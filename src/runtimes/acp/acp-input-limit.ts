const MAX_ACP_MESSAGE_BYTES = 8 * 1_024 * 1_024;

export function limitAcpInput(
  input: ReadableStream<Uint8Array>,
  maxMessageBytes = MAX_ACP_MESSAGE_BYTES,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new RangeError("ACP message byte limit must be a positive safe integer.");
  }

  let pendingBytes = 0;
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          if (byte === 0x0a) {
            pendingBytes = 0;
          } else {
            pendingBytes += 1;
            if (pendingBytes > maxMessageBytes) {
              throw new Error(`ACP message exceeds ${maxMessageBytes} bytes.`);
            }
          }
        }

        controller.enqueue(chunk);
      },
    }),
  );
}
