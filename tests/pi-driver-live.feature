Feature: Pi live upstream endpoint fixture

  Scenario: Forward Pi live requests through a configured OpenAI-compatible endpoint
    Given the Pi live fixture has an OpenAI-compatible base URL ending in /v1
    When the fixture builds the chat completions request URL
    Then it appends /chat/completions to the configured base URL

  Scenario: Preserve the default Pi live upstream endpoint
    Given the Pi live fixture has no configured base URL
    When the fixture builds the chat completions request URL
    Then it uses the default OpenRouter base URL followed by /chat/completions

  Scenario: Keep event metadata out of the input command
    Given a Pi live turn tracks an event index for event assertions
    When the fixture enqueues its input.start command
    Then the command contains only the production input.start fields
    And the event index remains fixture metadata
