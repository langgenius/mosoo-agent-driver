Feature: Tool call status validation in artifact lifecycle checks

  Scenario: Accept every canonical tool call status
    Given a packed driver emits a tool.call.updated event
    When the lifecycle assertion validates its status
    Then cancelled, completed, failed, and running are accepted

  Scenario: Reject statuses outside the tool call contract
    Given a packed driver emits a tool.call.updated event
    When the lifecycle assertion validates an unknown status
    Then the status is rejected

  Scenario: Allow authoritative terminal patches without reopening the tool
    Given a tool emits running, failed, and authoritative failed updates
    When the lifecycle assertion summarizes the updates
    Then the tool has a running update before terminal updates
    And every terminal update has the same status
    And no running update follows a terminal update

  Scenario: Reject a tool that reopens after terminal status
    Given a tool emits running, completed, and running updates
    When the lifecycle assertion summarizes the updates
    Then a running update follows a terminal update
