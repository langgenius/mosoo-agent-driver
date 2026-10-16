Feature: ACP session metadata delivery

  Scenario: Deliver session metadata after a cancelled run terminal
    Given a cancelled run terminal is still being acknowledged
    When the provider sends a session metadata update after cancellation
    Then the metadata waits for the run terminal
    And the metadata is delivered as a session event
    And the terminal settlement remains the only run terminal
