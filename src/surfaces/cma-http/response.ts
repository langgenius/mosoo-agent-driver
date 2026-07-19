import { CmaInvalidEventError, CmaUnsupportedFieldError } from "../../projections/cma";
import {
  CmaSessionTerminatedError,
  CmaStoreConflictError,
  CmaStoreNotFoundError,
} from "../../stores/cma-store";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  CmaHttpCapabilityGapError,
  CmaHttpDriverDispatchError,
  CmaHttpRequestError,
  type CmaHttpBetaHeaderRequirement,
} from "./contract";

export function createJsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });
}

export function createDataResponse(data: unknown, status = 200): Response {
  return createJsonResponse({ data }, status);
}

export function createErrorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return createJsonResponse(
    {
      error: {
        code,
        message,
        ...details,
      },
    },
    status,
  );
}

export function createMethodNotAllowedResponse(methods: readonly string[]): Response {
  return createErrorResponse(405, "CMA_METHOD_NOT_ALLOWED", "Method is not allowed.", {
    allow: methods,
  });
}

export function createNotFoundResponse(): Response {
  return createErrorResponse(404, "CMA_ROUTE_NOT_FOUND", "Route was not found.");
}

export function createBetaHeaderResponse(
  request: Request,
  requirement: CmaHttpBetaHeaderRequirement | false | undefined,
): Response | null {
  if (requirement === false) {
    return null;
  }

  const name = requirement?.name ?? CMA_DEFAULT_BETA_HEADER_NAME;
  const expectedValue = requirement?.value ?? CMA_DEFAULT_BETA_HEADER_VALUE;
  const actualValue = request.headers.get(name);

  if (!actualValue) {
    return createErrorResponse(
      400,
      "CMA_BETA_HEADER_REQUIRED",
      `CMA requires the ${name} header.`,
      {
        header: name,
      },
    );
  }

  const values = actualValue.split(",").map((value) => value.trim());

  if (!values.includes(expectedValue)) {
    return createErrorResponse(
      400,
      "CMA_UNSUPPORTED_BETA_HEADER",
      `CMA requires beta header ${expectedValue}.`,
      {
        expected: expectedValue,
        header: name,
      },
    );
  }

  return null;
}

export function createThrownErrorResponse(error: unknown): Response {
  if (error instanceof CmaInvalidEventError) {
    return createErrorResponse(400, "CMA_INVALID_EVENT", error.message);
  }

  if (error instanceof CmaUnsupportedFieldError) {
    return createErrorResponse(400, "CMA_UNSUPPORTED_FIELD", error.message, {
      field: error.field,
    });
  }

  if (error instanceof CmaHttpRequestError) {
    return createErrorResponse(error.status, error.code, error.message);
  }

  if (error instanceof CmaStoreConflictError) {
    return createErrorResponse(409, "CMA_RESOURCE_CONFLICT", error.message, {
      id: error.id,
      resource: error.resource,
    });
  }

  if (error instanceof CmaStoreNotFoundError) {
    return createErrorResponse(404, "CMA_RESOURCE_NOT_FOUND", error.message, {
      id: error.id,
      resource: error.resource,
    });
  }

  if (error instanceof CmaSessionTerminatedError) {
    return createErrorResponse(409, "CMA_SESSION_TERMINATED", error.message, {
      id: error.id,
    });
  }

  if (error instanceof CmaHttpDriverDispatchError) {
    return createErrorResponse(
      502,
      "CMA_DRIVER_COMMAND_DISPATCH_FAILED",
      "Driver command dispatch failed.",
    );
  }

  if (error instanceof CmaHttpCapabilityGapError) {
    return createErrorResponse(422, "CMA_CAPABILITY_GAP", error.message, {
      feature: error.feature,
    });
  }

  if (error instanceof RangeError) {
    return createErrorResponse(413, "CMA_RESOURCE_LIMIT", error.message);
  }

  return createErrorResponse(500, "CMA_INTERNAL_ERROR", "Internal server error.");
}
