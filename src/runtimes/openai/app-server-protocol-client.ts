import {
  initializeResponseSchema,
  threadBackgroundTerminalsCleanResponseSchema,
  threadInjectItemsResponseSchema,
  threadResumeResponseSchema,
  threadStartResponseSchema,
  turnStartResponseSchema,
} from "./app-server-protocol-client-schemas";
import type { ClientRequestMethod, ClientRequestResult } from "./app-server-protocol-types";

export const CLIENT_REQUEST_RESULT_PARSERS: {
  [Method in ClientRequestMethod]: (value: unknown) => ClientRequestResult[Method];
} = {
  initialize: (value) => initializeResponseSchema.parse(value),
  "thread/backgroundTerminals/clean": (value) =>
    threadBackgroundTerminalsCleanResponseSchema.parse(value),
  "thread/inject_items": (value) => threadInjectItemsResponseSchema.parse(value),
  "thread/resume": (value) => threadResumeResponseSchema.parse(value),
  "thread/start": (value) => threadStartResponseSchema.parse(value),
  "turn/start": (value) => turnStartResponseSchema.parse(value),
};
