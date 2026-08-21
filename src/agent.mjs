import crypto from "node:crypto";
import { classifyAction, inspectRequest } from "./policy.mjs";

const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const now = () => new Date().toISOString();

export class Agent {
  constructor({ store, planner, connectors, telemetry = null }) {
    this.store = store;
    this.planner = planner;
    this.connectors = connectors;
    this.telemetry = telemetry;
  }

  #metric(event, dimensions) {
    try { this.telemetry?.record(event, dimensions); } catch { /* Metrics must never affect an action. */ }
  }

  #approvalCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(crypto.randomInt(100000, 1_000_000));
      if (!this.store.getActionByCode(code)) return code;
    }
    throw new Error("Could not allocate an approval code.");
  }

  async createTask(prompt, { source = "web", sourceRef = null } = {}) {
    const inspection = inspectRequest(prompt);
    const task = { id: id("task"), prompt: String(prompt).trim(), summary: "Reviewing request", status: "planning", source, sourceRef, createdAt: now() };
    this.store.createTask(task);
    this.#metric("task_created", { source });
    this.store.addEvent({ taskId: task.id, kind: "request", message: `Request received from ${source} and policy check started.` });

    if (!inspection.allowed) {
      this.store.updateTask(task.id, { summary: inspection.reason, status: "blocked" });
      this.store.addEvent({ taskId: task.id, kind: "blocked", message: inspection.reason });
      this.#metric("task_blocked", { source });
      return this.store.state();
    }

    let plan;
    let plannerName;
    try {
      ({ plan, planner: plannerName } = await this.planner.plan(task.prompt));
    } catch (error) {
      plan = this.planner.fallback(task.prompt);
      plannerName = "fallback";
      this.#metric("planner_fallback", { source, planner: "fallback" });
      this.store.addEvent({ taskId: task.id, kind: "warning", message: `Planner unavailable; deterministic fallback used. ${String(error.message).slice(0, 260)}` });
    }

    this.store.updateTask(task.id, { summary: plan.summary, status: "active" });
    const plannerMode = plannerName === "fallback" ? "fallback" : this.planner.status().mode;
    this.#metric("plan_created", { source, planner: plannerMode });
    this.store.addEvent({ taskId: task.id, kind: "plan", message: `Typed plan created by ${plannerName}.` });

    let pending = 0;
    let failed = 0;
    let needsInput = false;
    for (const proposed of plan.actions) {
      const policy = classifyAction(proposed);
      const approvalCode = policy.level === "approval" ? this.#approvalCode() : null;
      const action = {
        id: id("act"), taskId: task.id, tool: proposed.tool, title: proposed.title,
        payload: proposed.payload, status: policy.level === "auto" ? "running" : policy.level,
        policyReason: policy.reason, approvalCode, createdAt: now()
      };
      this.store.createAction(action);
      this.#metric("action_proposed", { tool: action.tool, gate: policy.level });

      if (policy.level === "auto") {
        try {
          const result = await this.connectors.execute(action);
          this.store.decideAction(action.id, "completed", result);
          this.store.addEvent({ taskId: task.id, actionId: action.id, kind: "completed", message: result.message });
          this.#metric("action_finished", { tool: action.tool, outcome: "completed" });
          if (action.tool === "system.none") needsInput = true;
        } catch (error) {
          failed += 1;
          const result = { message: error.message, code: error.code || "connector_error", completedAt: now() };
          this.store.decideAction(action.id, "failed", result);
          this.store.addEvent({ taskId: task.id, actionId: action.id, kind: "warning", message: `${action.title}: ${error.message}` });
          this.#metric("action_finished", { tool: action.tool, outcome: "failed" });
        }
      } else if (policy.level === "approval") {
        pending += 1;
        this.store.addEvent({ taskId: task.id, actionId: action.id, kind: "approval", message: `${action.title} is waiting for approval code ${approvalCode}.` });
      } else {
        failed += 1;
        this.store.decideAction(action.id, "blocked", { message: policy.reason, completedAt: now() });
        this.store.addEvent({ taskId: task.id, actionId: action.id, kind: "blocked", message: policy.reason });
        this.#metric("action_finished", { tool: action.tool, outcome: "blocked" });
      }
    }

    const status = pending ? "waiting" : failed ? "failed" : needsInput ? "needs_input" : "completed";
    this.store.updateTask(task.id, { status });
    return this.store.state();
  }

  async decide(actionId, decision) {
    const action = this.store.getAction(actionId);
    if (!action) throw Object.assign(new Error("Action not found."), { statusCode: 404 });
    if (action.status !== "approval") throw Object.assign(new Error("Action is no longer awaiting approval."), { statusCode: 409 });

    if (decision !== "approve") {
      const result = { message: "Rejected by you; no action was taken.", external: false, completedAt: now() };
      this.store.decideAction(action.id, "rejected", result);
      this.store.addEvent({ taskId: action.taskId, actionId: action.id, kind: "rejected", message: result.message });
      this.#metric("approval_decided", { tool: action.tool, outcome: "rejected" });
      this.#metric("action_finished", { tool: action.tool, outcome: "rejected" });
      this.#finishTask(action.taskId);
      return this.store.state();
    }

    try {
      this.#metric("approval_decided", { tool: action.tool, outcome: "approved" });
      const result = await this.connectors.execute(action);
      this.store.decideAction(action.id, "completed", result);
      this.store.addEvent({ taskId: action.taskId, actionId: action.id, kind: "completed", message: result.message });
      this.#metric("action_finished", { tool: action.tool, outcome: "completed" });
    } catch (error) {
      const result = { message: error.message, code: error.code || "connector_error", completedAt: now() };
      this.store.decideAction(action.id, "failed", result);
      this.store.addEvent({ taskId: action.taskId, actionId: action.id, kind: "warning", message: `${action.title}: ${error.message}` });
      this.#metric("action_finished", { tool: action.tool, outcome: "failed" });
    }
    this.#finishTask(action.taskId);
    return this.store.state();
  }

  async decideByCode(code, decision) {
    const action = this.store.getActionByCode(String(code));
    if (!action) throw Object.assign(new Error("Approval code not found."), { statusCode: 404 });
    return this.decide(action.id, decision);
  }

  #finishTask(taskId) {
    const actions = this.store.actionsForTask(taskId);
    const status = actions.some((item) => item.status === "approval") ? "waiting"
      : actions.some((item) => item.status === "failed" || item.status === "blocked") ? "failed"
      : "completed";
    this.store.updateTask(taskId, { status });
  }
}
