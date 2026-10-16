Feature: ACP live usage metadata validation

  Scenario: Accept native OpenCode step totals
    Given an ACP fallback run emits usage from OpenCode native step totals
    When the lifecycle assertion validates the usage metadata
    Then the native_step_totals source and anthropic_bucketed contract are accepted

  Scenario: Reject stale or unknown ACP usage metadata
    Given an ACP fallback run emits usage metadata
    When the lifecycle assertion validates a non-native source or contract
    Then the usage metadata is rejected
