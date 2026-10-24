Feature: Message and thought lifecycle terminal pairing

  Scenario: Accept every canonical message terminal outcome
    Given a message.started event has one message ID
    When the lifecycle assertion validates its terminal event
    Then message.completed, message.cancelled, and message.failed each close exactly one message

  Scenario: Accept every canonical thought terminal outcome
    Given a thought.started event has one thought ID
    When the lifecycle assertion validates its terminal event
    Then thought.completed and thought.cancelled each close exactly one thought

  Scenario: Reject non-terminal message events
    Given a message event has a kind outside the message terminal contract
    When the lifecycle assertion validates its terminal event
    Then the event is rejected
