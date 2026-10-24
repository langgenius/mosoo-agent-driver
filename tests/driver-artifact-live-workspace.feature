Feature: Live workspace CRUD preserves the requested file bytes

  Scenario: Edit a Unicode path while preserving its trailing newline
    Given the workspace contains a file named "edit target-中.txt" with "before" and a trailing newline
    When the live prompt requests replacing "before" with "after" and preserving the trailing newline
    Then the file contains exactly "after" and a trailing newline
    And the requested read, create, and delete operations also complete
