export const AGENT_DRIVER_TESTING_FIXTURES = {
  cma: {
    commands: {
      inputStart: "tests/fixtures/cma/commands/input-start.json",
    },
    driverEvents: {
      permissionRequested: "tests/fixtures/cma/driver-events/permission-requested.json",
    },
    http: {
      createEnvironmentLimitedRequest:
        "tests/fixtures/cma/http/create-environment-limited-request.json",
      createEnvironmentLimitedResponse:
        "tests/fixtures/cma/http/create-environment-limited-response.json",
      createEnvironmentSelfHostedError:
        "tests/fixtures/cma/http/create-environment-self-hosted-error.json",
      createEnvironmentSelfHostedRequest:
        "tests/fixtures/cma/http/create-environment-self-hosted-request.json",
    },
    inbound: {
      userMessage: "tests/fixtures/cma/inbound/user-message.json",
    },
    outbound: {
      permissionRequiresAction: "tests/fixtures/cma/outbound/permission-requires-action.json",
    },
  },
  driver: {
    commands: {
      inputStart: "tests/fixtures/driver/commands/input-start.json",
      mcpExecute: "tests/fixtures/driver/commands/mcp-execute.json",
      permissionResolve: "tests/fixtures/driver/commands/permission-resolve.json",
      sessionStop: "tests/fixtures/driver/commands/session-stop.json",
      turnCancel: "tests/fixtures/driver/commands/turn-cancel.json",
    },
    runtimeEventDrafts: {
      diagnosticReported: "tests/fixtures/driver/runtime-event-drafts/diagnostic-reported.json",
      messageDelta: "tests/fixtures/driver/runtime-event-drafts/message-delta.json",
      permissionRequested: "tests/fixtures/driver/runtime-event-drafts/permission-requested.json",
      runStarted: "tests/fixtures/driver/runtime-event-drafts/run-started.json",
      toolCallUpdated: "tests/fixtures/driver/runtime-event-drafts/tool-call-updated.json",
      usageUpdated: "tests/fixtures/driver/runtime-event-drafts/usage-updated.json",
    },
    runtimeEventEnvelopes: {
      diagnosticReported: "tests/fixtures/driver/runtime-event-envelopes/diagnostic-reported.json",
      messageDelta: "tests/fixtures/driver/runtime-event-envelopes/message-delta.json",
      permissionRequested:
        "tests/fixtures/driver/runtime-event-envelopes/permission-requested.json",
      runStarted: "tests/fixtures/driver/runtime-event-envelopes/run-started.json",
      toolCallUpdated: "tests/fixtures/driver/runtime-event-envelopes/tool-call-updated.json",
      usageUpdated: "tests/fixtures/driver/runtime-event-envelopes/usage-updated.json",
    },
  },
  providers: {
    acp: {
      maxTurnFailure: "tests/fixtures/providers/acp/cases/max-turn-failure.json",
      permissionRequest: "tests/fixtures/providers/acp/cases/permission-request.json",
      sessionReady: "tests/fixtures/providers/acp/cases/session-ready.json",
      thoughtAndUnknownUpdate: "tests/fixtures/providers/acp/cases/thought-and-unknown-update.json",
      turnTextToolUsage: "tests/fixtures/providers/acp/cases/turn-text-tool-usage.json",
    },
    claudeAgentSdk: {
      assistantFinalMessage:
        "tests/fixtures/providers/claude-agent-sdk/cases/assistant-final-message.json",
      resultFailureDiagnostic:
        "tests/fixtures/providers/claude-agent-sdk/cases/result-failure-diagnostic.json",
      streamTextThinkingToolResult:
        "tests/fixtures/providers/claude-agent-sdk/cases/stream-text-thinking-tool-result.json",
      systemFilesAndSession:
        "tests/fixtures/providers/claude-agent-sdk/cases/system-files-and-session.json",
      unknownMessageIgnored:
        "tests/fixtures/providers/claude-agent-sdk/cases/unknown-message-ignored.json",
    },
    openaiAppServer: {
      agentMessageCompleted:
        "tests/fixtures/providers/openai-app-server/cases/agent-message-completed.json",
      commandOutputStream:
        "tests/fixtures/providers/openai-app-server/cases/command-output-stream.json",
      errorBeforeTrackedTurn:
        "tests/fixtures/providers/openai-app-server/cases/error-before-tracked-turn.json",
      turnCompletedWithFinalAgentMessage:
        "tests/fixtures/providers/openai-app-server/cases/turn-completed-with-final-agent-message.json",
      turnPlanUpdated: "tests/fixtures/providers/openai-app-server/cases/turn-plan-updated.json",
      unknownNotificationIgnored:
        "tests/fixtures/providers/openai-app-server/cases/unknown-notification-ignored.json",
    },
  },
} as const;

export const AGENT_DRIVER_TESTING_FIXTURE_PATHS = [
  AGENT_DRIVER_TESTING_FIXTURES.cma.commands.inputStart,
  AGENT_DRIVER_TESTING_FIXTURES.cma.driverEvents.permissionRequested,
  AGENT_DRIVER_TESTING_FIXTURES.cma.http.createEnvironmentLimitedRequest,
  AGENT_DRIVER_TESTING_FIXTURES.cma.http.createEnvironmentLimitedResponse,
  AGENT_DRIVER_TESTING_FIXTURES.cma.http.createEnvironmentSelfHostedError,
  AGENT_DRIVER_TESTING_FIXTURES.cma.http.createEnvironmentSelfHostedRequest,
  AGENT_DRIVER_TESTING_FIXTURES.cma.inbound.userMessage,
  AGENT_DRIVER_TESTING_FIXTURES.cma.outbound.permissionRequiresAction,
  AGENT_DRIVER_TESTING_FIXTURES.driver.commands.inputStart,
  AGENT_DRIVER_TESTING_FIXTURES.driver.commands.mcpExecute,
  AGENT_DRIVER_TESTING_FIXTURES.driver.commands.permissionResolve,
  AGENT_DRIVER_TESTING_FIXTURES.driver.commands.sessionStop,
  AGENT_DRIVER_TESTING_FIXTURES.driver.commands.turnCancel,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventDrafts.diagnosticReported,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventDrafts.messageDelta,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventDrafts.permissionRequested,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventDrafts.runStarted,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventDrafts.toolCallUpdated,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventDrafts.usageUpdated,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventEnvelopes.diagnosticReported,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventEnvelopes.messageDelta,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventEnvelopes.permissionRequested,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventEnvelopes.runStarted,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventEnvelopes.toolCallUpdated,
  AGENT_DRIVER_TESTING_FIXTURES.driver.runtimeEventEnvelopes.usageUpdated,
  AGENT_DRIVER_TESTING_FIXTURES.providers.acp.maxTurnFailure,
  AGENT_DRIVER_TESTING_FIXTURES.providers.acp.permissionRequest,
  AGENT_DRIVER_TESTING_FIXTURES.providers.acp.sessionReady,
  AGENT_DRIVER_TESTING_FIXTURES.providers.acp.thoughtAndUnknownUpdate,
  AGENT_DRIVER_TESTING_FIXTURES.providers.acp.turnTextToolUsage,
  AGENT_DRIVER_TESTING_FIXTURES.providers.claudeAgentSdk.assistantFinalMessage,
  AGENT_DRIVER_TESTING_FIXTURES.providers.claudeAgentSdk.resultFailureDiagnostic,
  AGENT_DRIVER_TESTING_FIXTURES.providers.claudeAgentSdk.streamTextThinkingToolResult,
  AGENT_DRIVER_TESTING_FIXTURES.providers.claudeAgentSdk.systemFilesAndSession,
  AGENT_DRIVER_TESTING_FIXTURES.providers.claudeAgentSdk.unknownMessageIgnored,
  AGENT_DRIVER_TESTING_FIXTURES.providers.openaiAppServer.agentMessageCompleted,
  AGENT_DRIVER_TESTING_FIXTURES.providers.openaiAppServer.commandOutputStream,
  AGENT_DRIVER_TESTING_FIXTURES.providers.openaiAppServer.errorBeforeTrackedTurn,
  AGENT_DRIVER_TESTING_FIXTURES.providers.openaiAppServer.turnCompletedWithFinalAgentMessage,
  AGENT_DRIVER_TESTING_FIXTURES.providers.openaiAppServer.turnPlanUpdated,
  AGENT_DRIVER_TESTING_FIXTURES.providers.openaiAppServer.unknownNotificationIgnored,
] as const;

export type AgentDriverTestingFixtureManifest = typeof AGENT_DRIVER_TESTING_FIXTURES;
export type AgentDriverTestingFixturePath = (typeof AGENT_DRIVER_TESTING_FIXTURE_PATHS)[number];
