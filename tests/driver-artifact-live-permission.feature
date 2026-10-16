Feature: Supervised permission terminal outcomes

  Scenario: Preserve provider-specific terminal semantics after rejecting a permission
    Given a supervised permission request is resolved with reject_once
    When the provider handles the rejected tool request
    Then OpenAI interrupted turns produce run.cancelled and a cancelled input command
    And other live runtimes produce run.completed and a completed input command
    And permission lifecycle and rejected file assertions remain valid
