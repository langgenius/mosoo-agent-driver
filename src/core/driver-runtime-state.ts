export type DriverRuntimeStatus =
  | "created"
  | "starting"
  | "ready"
  | "running"
  | "needs_approval"
  | "stopping"
  | "stopped"
  | "failed";

export const DRIVER_RUNTIME_TRANSITIONS: Readonly<
  Record<DriverRuntimeStatus, readonly DriverRuntimeStatus[]>
> = {
  created: ["starting", "failed", "stopping"],
  failed: [],
  needs_approval: ["running", "ready", "failed", "stopping"],
  ready: ["running", "failed", "stopping"],
  running: ["needs_approval", "ready", "failed", "stopping"],
  starting: ["ready", "failed", "stopping"],
  stopped: ["failed"],
  stopping: ["failed", "stopped"],
};

export class DriverRuntimeStateMachine {
  #activeApprovals = 0;
  #activeRunGeneration: number | null = null;
  #status: DriverRuntimeStatus;

  constructor(initialStatus: DriverRuntimeStatus) {
    this.#status = initialStatus;
  }

  status(): DriverRuntimeStatus {
    return this.#status;
  }

  isShuttingDown(): boolean {
    return this.#status === "failed" || this.#status === "stopped" || this.#status === "stopping";
  }

  beginRun(generation: number): void {
    this.enter("running");
    this.#activeRunGeneration = generation;
    this.#activeApprovals = 0;
  }

  endRun(generation: number): void {
    if (this.#activeRunGeneration !== generation) {
      return;
    }

    this.#activeRunGeneration = null;
    this.#activeApprovals = 0;

    if (this.#status === "running" || this.#status === "needs_approval") {
      this.enter("ready");
    }
  }

  ownsRun(generation: number): boolean {
    return this.#activeRunGeneration === generation;
  }

  beginApproval(): number | null {
    const generation = this.#activeRunGeneration;

    if (generation === null || (this.#status !== "running" && this.#status !== "needs_approval")) {
      return null;
    }

    this.#activeApprovals += 1;
    this.enter("needs_approval");
    return generation;
  }

  endApproval(generation: number | null): void {
    if (generation === null || this.#activeRunGeneration !== generation) {
      return;
    }

    this.#activeApprovals -= 1;

    if (this.#activeApprovals === 0 && this.#status === "needs_approval") {
      this.enter("running");
    }
  }

  enter(next: DriverRuntimeStatus): void {
    if (next === this.#status) {
      return;
    }

    if (!DRIVER_RUNTIME_TRANSITIONS[this.#status].includes(next)) {
      throw new Error(`Invalid driver runtime state transition: ${this.#status} -> ${next}.`);
    }

    this.#status = next;
  }
}

export {
  DriverTurnCancellationCleanupError,
  DriverTurnCancelledError,
  isDriverTurnCancelledError,
} from "./driver-turn-cancelled-error";
