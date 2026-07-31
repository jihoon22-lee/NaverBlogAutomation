/**
 * Execution state for one approved post.
 *
 * The service owns the run record, so this state only mirrors what the stream reported and what the
 * user may still do. A step whose result is unknown never offers an automatic retry; it offers a
 * manual-completion record instead.
 */

import type { EngagementRun, EngagementStep, EngagementStepName } from "../api/types";

export type RunPhase = "idle" | "starting" | "running" | "finished" | "refused";

export interface RunStepView {
  name: EngagementStepName;
  resultCode: string | null;
  state: EngagementStep["state"];
}

export interface RunState {
  error: string | null;
  manualSteps: EngagementStepName[];
  phase: RunPhase;
  reconnects: number;
  run: EngagementRun | null;
  steps: RunStepView[];
  streamClosed: boolean;
}

export const STEP_ORDER: readonly EngagementStepName[] = ["like", "comment", "mutual_neighbor"];

export function initialRunState(): RunState {
  return {
    error: null,
    manualSteps: [],
    phase: "idle",
    reconnects: 0,
    run: null,
    steps: [],
    streamClosed: false,
  };
}

export function startingRun(state: RunState): RunState {
  return { ...state, error: null, phase: "starting", reconnects: 0, streamClosed: false };
}

export function withRun(state: RunState, run: EngagementRun): RunState {
  return {
    ...state,
    error: null,
    phase: isTerminal(run) ? "finished" : "running",
    run,
    steps: run.steps.map((step) => ({
      name: step.name,
      resultCode: step.resultCode,
      state: step.state,
    })),
  };
}

export function withRefusal(state: RunState, message: string): RunState {
  return { ...state, error: message, phase: "refused" };
}

/** Apply one streamed step result without waiting for a fresh run read. */
export function withStepResult(
  state: RunState,
  name: EngagementStepName,
  stepState: EngagementStep["state"],
  resultCode: string | null,
): RunState {
  const steps = state.steps.some((step) => step.name === name)
    ? state.steps.map((step) =>
        step.name === name ? { name, resultCode, state: stepState } : step,
      )
    : [...state.steps, { name, resultCode, state: stepState }];
  return { ...state, steps: sortSteps(steps) };
}

export function withStreamClosed(state: RunState): RunState {
  return {
    ...state,
    phase: state.phase === "starting" ? "running" : state.phase,
    streamClosed: true,
  };
}

export function withReconnect(state: RunState): RunState {
  return { ...state, reconnects: state.reconnects + 1 };
}

export function withManualSteps(state: RunState, steps: EngagementStepName[]): RunState {
  return { ...state, manualSteps: [...steps] };
}

export function toggledManualStep(state: RunState, name: EngagementStepName): RunState {
  const selected = state.manualSteps.includes(name)
    ? state.manualSteps.filter((step) => step !== name)
    : [...state.manualSteps, name];
  return withManualSteps(state, selected);
}

/** Report whether the run stopped with at least one step the user must resolve by hand. */
export function needsManualResolution(state: RunState): boolean {
  if (state.phase !== "finished") return false;
  return state.steps.some((step) => step.state === "failed" || step.state === "unconfirmed");
}

export function isBusy(state: RunState): boolean {
  return state.phase === "starting" || state.phase === "running";
}

function isTerminal(run: EngagementRun): boolean {
  return run.state !== "running";
}

function sortSteps(steps: RunStepView[]): RunStepView[] {
  return [...steps].sort((left, right) => order(left.name) - order(right.name));
}

function order(name: EngagementStepName): number {
  const index = STEP_ORDER.indexOf(name);
  return index === -1 ? STEP_ORDER.length : index;
}
