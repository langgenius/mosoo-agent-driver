Feature: OpenAI cancellation native-thread recovery

  Scenario: Start a fresh thread after cancelling before native history exists
    Given the OpenAI app-server has started a thread with no successful persisted turn
    When that first turn is cancelled after its start response is acknowledged
    And no native turn has completed
    And the next input is dispatched
    Then the replacement client starts a fresh thread
    And it does not resume the cancelled thread

  Scenario: Resume an established native thread after cancellation
    Given the OpenAI app-server has a native checkpoint for the thread
    When a turn on that thread is cancelled before its start response completes
    And the next input is dispatched
    Then the replacement client resumes the existing thread

  Scenario: Preserve same-process history across a completed turn and cancellation
    Given a turn completes and writes a native checkpoint in the current process
    When the next turn is cancelled
    And the app-server's SQLite projection is stale
    And another input is dispatched
    Then the latest verified checkpoint is restored before the replacement client starts
    And the replacement client resumes the established native thread
