Feature: ACP cancelled provider tree recycling

  Scenario: Observe a detached child before recycling a cancelled provider
    Given a provider prompt is blocked and the cancellation fixture will spawn a detached child
    When ACP cancellation is requested while the cancellation event publication is held
    And the fixture publishes the detached child's PID
    And the cancellation event publication is released
    Then the cancelled provider tree is recycled before terminal delivery
    And the detached child is no longer running
    And the ACP session resumes for the next turn

  Scenario: Stop an active provider tree before its cancellation terminal
    Given a blocked Linux provider prompt has a detached child running
    When ACP session stop is requested
    Then the detached child is no longer running when run.cancelled is delivered

  Scenario: Keep a resumed provider alive after the recycle deadline
    Given a cancelled provider is successfully resumed
    When the next turn completes after the recycle deadline
    Then the resumed provider remains alive until explicit cleanup
