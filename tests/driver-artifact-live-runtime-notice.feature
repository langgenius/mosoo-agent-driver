Feature: OpenAI runtime notices in artifact lifecycle checks

  Scenario: Allow a known driver runtime notice before run.started
    Given a message.added event has driver actor and origin, agent role, and a known runtime notice subtype
    When the packed driver lifecycle assertion checks projection ordering
    Then the notice may precede run.started

  Scenario: Keep ordinary agent output subject to start ordering
    Given a message.added event has driver actor and origin with the agent role and ordinary output content
    When the streamed-message pairing assertion checks the output
    Then the output must have message.started and message.completed events

  Scenario: Keep a known driver runtime notice standalone
    Given a message.added event has driver actor and origin, agent role, and a known runtime notice subtype
    When the streamed-message pairing assertion checks the notice
    Then the notice does not require message.started or message.completed events

  Scenario: Ignore a known runtime notice when checking resume history
    Given a known driver runtime notice precedes a resumed run.started event
    When the historical projection assertion checks events before run.started
    Then the notice is allowed while historical output remains rejected

  Scenario: Reject runtime notices with untrusted metadata
    Given a message.added event has a foreign actor or origin, or an unknown subtype
    When the packed driver lifecycle assertion classifies the event
    Then it is not treated as a known runtime notice
