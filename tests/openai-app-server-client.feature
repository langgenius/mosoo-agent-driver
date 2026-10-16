Feature: OpenAI app-server notification backpressure

  Scenario: Observe burst completion after the marker was initially absent
    Given the fake app-server writes a notification burst with a completion marker
    And the completion marker is absent while the first notification handler is blocked
    When the client drains the accepted notifications below the queue limit
    Then all notifications are handled after the blocked handler is released
    And filesystem notification observes the write callback's completion marker within a bounded wait
    And a fresh filesystem check observes the marker without a cached negative result
    And the test does not poll or sleep to infer completion

  Scenario: Preserve queue overflow handling for oversized notification bursts
    Given the fake app-server writes a notification burst above the queue limit
    When the client drains the accepted notifications
    Then the drain rejects with the queue limit error
    And exactly one protocol error is reported
