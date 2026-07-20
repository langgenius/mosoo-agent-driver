import type { CmaStore } from "../../stores/cma-store";
import { CMA_HTTP_METHODS, type CmaHttpHandler, type CmaHttpHandlerOptions } from "./contract";
import {
  readCmaJsonBody,
  readCmaPathSegments,
  readCreateAgentInput,
  readCreateEnvironmentInput,
  readCreateSessionInput,
} from "./request";
import {
  createBetaHeaderResponse,
  createDataResponse,
  createErrorResponse,
  createMethodNotAllowedResponse,
  createNotFoundResponse,
  createThrownErrorResponse,
} from "./response";
import { handleGetSessionEvents, handlePostSessionEvent } from "./session-events";

async function handleAgents(
  request: Request,
  segments: readonly string[],
  store: CmaStore,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "GET") {
      return createDataResponse(await store.listAgents());
    }

    if (request.method === "POST") {
      return createDataResponse(
        await store.createAgent(readCreateAgentInput(await readCmaJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.agents);
  }

  if (segments.length === 3) {
    const agentId = segments[2];

    if (agentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const agent = await store.getAgent(agentId);
      return agent
        ? createDataResponse(agent)
        : createErrorResponse(404, "CMA_AGENT_NOT_FOUND", "Agent was not found.");
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.get);
  }

  return createNotFoundResponse();
}

async function handleEnvironments(
  request: Request,
  segments: readonly string[],
  store: CmaStore,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "GET") {
      return createDataResponse(await store.listEnvironments());
    }

    if (request.method === "POST") {
      return createDataResponse(
        await store.createEnvironment(readCreateEnvironmentInput(await readCmaJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.environments);
  }

  if (segments.length === 3) {
    const environmentId = segments[2];

    if (environmentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const environment = await store.getEnvironment(environmentId);
      return environment
        ? createDataResponse(environment)
        : createErrorResponse(404, "CMA_ENVIRONMENT_NOT_FOUND", "Environment was not found.");
    }

    if (request.method === "DELETE") {
      const deleted = await store.deleteEnvironment(environmentId);
      return deleted
        ? new Response(null, { status: 204 })
        : createErrorResponse(404, "CMA_ENVIRONMENT_NOT_FOUND", "Environment was not found.");
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.environment);
  }

  if (segments.length === 4 && segments[3] === "archive") {
    const environmentId = segments[2];

    if (environmentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "POST") {
      return createDataResponse(await store.archiveEnvironment(environmentId));
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.post);
  }

  return createNotFoundResponse();
}

async function handleSessions(
  request: Request,
  segments: readonly string[],
  options: CmaHttpHandlerOptions,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "POST") {
      return createDataResponse(
        await options.store.createSession(readCreateSessionInput(await readCmaJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.post);
  }

  if (segments.length === 3) {
    const sessionId = segments[2];

    if (sessionId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const session = await options.store.getSession(sessionId);
      return session
        ? createDataResponse(session)
        : createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.get);
  }

  if (segments.length === 4 && segments[3] === "events") {
    const sessionId = segments[2];

    if (sessionId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      return handleGetSessionEvents(request, sessionId, options.store);
    }

    if (request.method === "POST") {
      return handlePostSessionEvent(
        request,
        sessionId,
        options.store,
        options.dispatchDriverCommand,
      );
    }

    return createMethodNotAllowedResponse(CMA_HTTP_METHODS.sessionEvents);
  }

  return createNotFoundResponse();
}

export function createCmaHttpHandler(options: CmaHttpHandlerOptions): CmaHttpHandler {
  return async (request) => {
    try {
      const segments = readCmaPathSegments(request);

      if (segments[0] !== "v1") {
        return createNotFoundResponse();
      }

      const betaHeaderResponse = createBetaHeaderResponse(request, options.betaHeader);

      if (betaHeaderResponse) {
        return betaHeaderResponse;
      }

      const authorizationResponse = await options.authorize?.({ request, segments });

      if (authorizationResponse) {
        return authorizationResponse;
      }

      switch (segments[1]) {
        case "agents":
          return await handleAgents(request, segments, options.store);
        case "environments":
          return await handleEnvironments(request, segments, options.store);
        case "sessions":
          return await handleSessions(request, segments, options);
        default:
          return createNotFoundResponse();
      }
    } catch (error) {
      return createThrownErrorResponse(error);
    }
  };
}
